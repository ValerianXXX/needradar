import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { embeddingInput, encoderId, normalizedVector } from './embedding-contract.mjs';

// Optional trusted operator configuration. No network requests, model downloads,
// shell interpolation or changes to the user's Agent environment occur here.
export function createLocalEncoder({ pythonExecutable, modelDirectory, allowExecution = false, timeoutMs = 900000, threads = 2 } = {}) {
  if (!allowExecution || typeof pythonExecutable !== 'string' || !isAbsolute(pythonExecutable)
    || typeof modelDirectory !== 'string' || !isAbsolute(modelDirectory)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000
    || !Number.isInteger(threads) || threads < 1 || threads > 8) throw new TypeError('EXPLICIT_LOCAL_ENCODER_CONFIGURATION_REQUIRED');
  const cache = new Map();
  return async drafts => {
    if (!Array.isArray(drafts) || !drafts.length || drafts.length > 10000) throw new TypeError('ENCODER_BATCH_LIMIT');
    const inputs = drafts.map(embeddingInput);
    const cached = new Map(inputs.filter(row => cache.has(row.inputDigest)).map(row => [row.inputDigest, cache.get(row.inputDigest)]));
    const pending = [...new Map(inputs.filter(row => !cache.has(row.inputDigest)).map(row => [row.inputDigest, row])).values()];
    const started = performance.now();
    let observation = { encoded: 0, cloudRequests: 0, batches: 0, runtime: null, provider: null, startupMs: 0, inferenceMs: 0 };
    if (pending.length) {
      const payload = JSON.stringify({ protocol: 'NEEDRADAR_EMBED_REQUEST_V1', encoderId, rows: pending });
      if (Buffer.byteLength(payload) > 32000000) throw new TypeError('ENCODER_INPUT_LIMIT');
      const fresh = new Map(), expected = new Set(pending.map(row => row.inputDigest));
      await new Promise((resolve, reject) => {
        const child = spawn(pythonExecutable, ['-I', fileURLToPath(new URL('../scripts/local-embed.py', import.meta.url)),
          '--model-dir', modelDirectory, '--threads', String(threads)], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let buffer = '', stderrBytes = 0, ready = false, done = false, failed = false;
        const fail = code => { if (failed) return; failed = true; clearTimeout(timer); child.kill(); reject(new Error(code)); };
        const timer = setTimeout(() => fail('LOCAL_ENCODER_TIMEOUT'), timeoutMs);
        const receive = line => {
          const item = JSON.parse(line);
          if (item.type === 'ERROR') throw new Error(item.code === 'ENCODER_TOKEN_LIMIT' ? 'ENCODER_TOKEN_LIMIT' : 'LOCAL_ENCODER_FAILED');
          if (item.encoderId !== encoderId || done) throw new Error('INVALID_ENCODER_STREAM');
          if (item.type === 'READY' && !ready) {
            ready = true;
            observation = { ...observation, runtime: item.runtime, provider: item.provider, startupMs: item.startupMs };
          } else if (item.type === 'BATCH' && ready && Array.isArray(item.rows) && item.rows.length <= 16) {
            for (const row of item.rows) {
              if (!expected.has(row.inputDigest) || fresh.has(row.inputDigest) || !Number.isInteger(row.tokens) || row.tokens < 1 || row.tokens > 512) throw new Error('INVALID_ENCODER_STREAM');
              fresh.set(row.inputDigest, { encoderId, inputDigest: row.inputDigest, tokens: row.tokens, vector: normalizedVector(row.vector) });
            }
            observation.batches++;
            observation.inferenceMs += item.elapsedMs;
          } else if (item.type === 'DONE' && ready && item.encoded === pending.length && fresh.size === pending.length && item.cloudRequests === 0) {
            done = true;
            observation.encoded = item.encoded;
          } else throw new Error('INVALID_ENCODER_STREAM');
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          if (failed) return;
          buffer += chunk;
          try {
            if (buffer.length > 1000000) throw new Error('ENCODER_OUTPUT_LIMIT');
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (line) receive(line); }
          } catch (error) { fail(error.message === 'ENCODER_TOKEN_LIMIT' ? error.message : 'INVALID_ENCODER_STREAM'); }
        });
        child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) fail('ENCODER_OUTPUT_LIMIT'); });
        child.on('error', () => fail('LOCAL_ENCODER_START_FAILED'));
        child.stdin.on('error', () => fail('LOCAL_ENCODER_INPUT_FAILED'));
        child.on('close', code => {
          clearTimeout(timer);
          if (failed) return;
          if (code !== 0 || !done || buffer.trim()) fail('INCOMPLETE_ENCODER_RESULT');
          else resolve();
        });
        child.stdin.end(payload);
      });
      // Failed or incomplete runs never populate the cache with partial output.
      for (const [key, value] of fresh) cache.set(key, value);
      while (cache.size > 10000) cache.delete(cache.keys().next().value);
      // Preserve this request's results even when it displaces older cache entries.
      return { encoderId, rows: inputs.map(row => ({ ...(fresh.get(row.inputDigest) ?? cached.get(row.inputDigest)),
        vector: Float32Array.from((fresh.get(row.inputDigest) ?? cached.get(row.inputDigest)).vector) })),
        observation: { ...observation, reusedInputs: inputs.length - pending.length, elapsedMs: performance.now() - started } };
    }
    return { encoderId, rows: inputs.map(row => ({ ...cache.get(row.inputDigest), vector: Float32Array.from(cache.get(row.inputDigest).vector) })),
      observation: { ...observation, reusedInputs: inputs.length, elapsedMs: performance.now() - started } };
  };
}
