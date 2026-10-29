import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Executable/args are operator configuration. They must never come from a brief or model.
export function createCommandReviewer({ executable, args = [], allowExecution = false, timeoutMs = 90000 } = {}) {
  if (!allowExecution || typeof executable !== 'string' || !executable || !Array.isArray(args)
      || args.some((arg) => typeof arg !== 'string') || !Number.isInteger(timeoutMs)
      || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('EXPLICIT_COMMAND_CONFIGURATION_REQUIRED');
  return async (request) => {
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > 30000) throw new Error('REVIEW_INPUT_TOO_LARGE');
    const cwd = await mkdtemp(join(tmpdir(), 'needradar-review-'));
    const started = performance.now();
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [];
        let bytes = 0, failed = false;
        const fail = () => { failed = true; child.kill(); reject(new Error('COMMAND_REVIEW_FAILED')); };
        const timer = setTimeout(fail, timeoutMs);
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 262144) fail(); else chunks.push(chunk); });
        child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > 262144) fail(); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failed) return;
          try {
            if (code !== 0) throw new Error();
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (value.toolCalls !== 0 || !value.decision || typeof value.model !== 'string') throw new Error();
            resolve({ decision: value.decision, model: value.model, toolCalls: 0,
              elapsedMs: Math.round(performance.now() - started), usage: null, costUsd: null });
          } catch { reject(new Error('INVALID_COMMAND_REVIEW')); }
        });
        child.stdin.end(payload);
      });
      return result;
    } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };
}
