import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createLocalEncoder } from '../src/local-encoder.mjs';
import { verifyEmbedding } from '../src/embedding-contract.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
if (!output || process.env.NEEDRADAR_ALLOW_LOCAL_ENCODER !== 'true') throw new Error('EXPLICIT_LOCAL_CHECK_REQUIRED');
const receipt = await open(output, 'wx');
const settings = { pythonExecutable: process.env.NEEDRADAR_ENCODER_PYTHON, modelDirectory: process.env.NEEDRADAR_ENCODER_MODEL_DIR,
  allowExecution: true, threads: 2 };
const sourceFiles = ['scripts/local-embed.py', 'src/local-encoder.mjs', 'src/embedding-contract.mjs', 'config/local-encoder.json', 'scripts/check-local-encoder.mjs'];
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
  createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
const observations = [];
try {
  const encode = createLocalEncoder(settings);
  const draft = { id: 'test', persona: 'Reviewers', jobToBeDone: 'Check a synthetic invoice against a synthetic original.', desiredOutcome: 'Verified fields' };
  const initial = await encode([draft]);
  observations.push({ check: 'ACTUAL_LOCAL_MODEL', result: 'PASS', observation: initial.observation });
  assert.ok(initial.rows[0].tokens > 0);
  verifyEmbedding(draft, initial.rows[0]);
  const renamed = { ...draft, persona: 'Auditors' };
  const reused = await encode([renamed]);
  assert.equal(reused.observation.encoded, 0);
  assert.deepEqual([...reused.rows[0].vector], [...initial.rows[0].vector]);
  assert.notEqual(reused.rows[0].identityDigest, initial.rows[0].identityDigest);
  assert.throws(() => verifyEmbedding(renamed, initial.rows[0]), /STALE_OR_INCOMPATIBLE/u);
  observations.push({ check: 'CACHE_REUSE_WITH_NEW_IDENTITY_BINDING', result: 'PASS' });
  reused.rows[0].vector[0] = 123;
  const again = await encode([draft]);
  assert.equal(again.rows[0].vector[0], initial.rows[0].vector[0]);
  observations.push({ check: 'RETURNED_VECTOR_MUTATION_ISOLATED', result: 'PASS' });
  const partial = Array.from({ length: 16 }, (_, index) => ({ ...draft, jobToBeDone: `Validate synthetic source record ${index} before accepting it.` }));
  const oversized = { ...draft, jobToBeDone: 'uncertainty '.repeat(700) };
  await assert.rejects(encode([...partial, oversized]), /ENCODER_TOKEN_LIMIT/u);
  const recovered = await encode([partial[0]]);
  assert.equal(recovered.observation.encoded, 1);
  observations.push({ check: 'NO_SILENT_TRUNCATION_OR_PARTIAL_CACHE_COMMIT', result: 'PASS', recovery: recovered.observation });
  await receipt.writeFile(asciiJSON({ observedAt: new Date().toISOString(), status: 'PASS', syntheticOnly: true, cloudRequests: 0,
    sourceLFHashes: hashes, observations, independentHumanAcceptance: false }));
  console.log(JSON.stringify({ checks: observations.length, status: 'PASS' }));
} catch (error) {
  await receipt.writeFile(asciiJSON({ observedAt: new Date().toISOString(), status: 'FAIL', syntheticOnly: true,
    sourceLFHashes: hashes, observations, error: error.code ?? 'LOCAL_CHECK_FAILED' }));
  throw error;
} finally { await receipt.close(); }
