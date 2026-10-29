// Opt-in only. Send fixed synthetic public fields to the configured command;
// keep a per-request journal even if interrupted. No automatic paid reruns.
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCommandReviewer } from '../src/command-reviewer.mjs';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';
import { evaluate } from './evaluate-boundaries.mjs';

const output = process.argv[process.argv.indexOf('--output') + 1];
if (!process.argv.includes('--command') || !process.argv.includes('--output') || !output
  || process.env.NEEDRADAR_ALLOW_COMMAND !== 'true') throw new Error('EXPLICIT_PILOT_CONFIGURATION_REQUIRED');
const pilotText = await readFile(new URL('../eval/boundaries-v2/pilot.json', import.meta.url), 'utf8');
const pilot = JSON.parse(pilotText), fixtures = await loadFixtures();
if (pilot.protocol !== 'BOUNDARY_PILOT_V1' || pilot.fixtureHash !== fixtureHash || pilot.maxModelCalls !== 12
  || !Array.isArray(pilot.selectedIds) || pilot.selectedIds.length !== 12 || new Set(pilot.selectedIds).size !== 12
  || pilot.selectedIds.some(id => !fixtures.cases.some(row => row.id === id))) throw new Error('INVALID_FIXED_PILOT');
const command = createCommandReviewer({ executable: process.env.NEEDRADAR_REVIEW_EXECUTABLE,
  args: JSON.parse(process.env.NEEDRADAR_REVIEW_ARGS ?? '[]'), allowExecution: true });
const runtime = JSON.parse(process.env.NEEDRADAR_REVIEW_RUNTIME ?? '{}');
const metadata = Object.fromEntries(['hermesRevision', 'pythonVersion', 'provider', 'configuredModel', 'verifiedAt']
  .filter(key => typeof runtime[key] === 'string').map(key => [key, runtime[key]]));
const files = ['src/similarity.mjs', 'src/semantic-review.mjs', 'src/timestamps.mjs', 'src/command-reviewer.mjs', 'scripts/hermes-review.py',
  'scripts/evaluate-boundaries.mjs', 'scripts/evaluate-boundary-pilot.mjs'];
const sourceLFHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
  createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
// Reserve both paths before any model calls; an existing receipt blocks reruns.
const receipt = await open(resolve(output), 'wx');
let journal;
try { journal = await open(resolve(output + '.requests.jsonl'), 'wx'); }
catch (error) { await receipt.close(); throw error; }
const started = performance.now(), observedAt = new Date().toISOString();
const environment = { observedAt, syntheticOnly: true, node: process.version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  workingTreeObservation: true, sourceLFHashes, runtime: metadata,
  pilotLFHash: createHash('sha256').update(pilotText.replaceAll('\r\n', '\n')).digest('hex'),
  toolCalls: 0, internalProviderRequests: null, billedCostUsd: null, liveBusinessOutcome: false };
let attempts = 0;
try {
  const before = await evaluate({ selectedIds: pilot.selectedIds });
  const reviewer = async request => {
    if (++attempts > pilot.maxModelCalls) throw new Error('PILOT_BUDGET_EXHAUSTED');
    await journal.write(asciiJSON({ type: 'REQUEST_STARTED', ordinal: attempts, at: new Date().toISOString(), request }).replace(/\n\s*/gu, '') + '\n');
    await journal.sync();
    try {
      const response = await command(request);
      await journal.write(asciiJSON({ type: 'RESPONSE', ordinal: attempts, at: new Date().toISOString(), response }).replace(/\n\s*/gu, '') + '\n');
      await journal.sync();
      console.log(JSON.stringify({ request: attempts, status: 'RESPONSE_RECEIVED' }));
      return response;
    } catch (error) {
      await journal.write(JSON.stringify({ type: 'REQUEST_FAILED', ordinal: attempts, at: new Date().toISOString(),
        reason: 'COMMAND_OR_TRANSPORT_FAILURE', detail: 'Provider errors and credentials are intentionally not recorded.' }) + '\n');
      await journal.sync();
      console.log(JSON.stringify({ request: attempts, status: 'FAILED' }));
      throw error;
    }
  };
  const after = await evaluate({ reviewer, maxModelCalls: pilot.maxModelCalls, selectedIds: pilot.selectedIds });
  await receipt.writeFile(asciiJSON({ ...environment, status: 'COMPLETED_OBSERVATION', pilot, before, after,
    adapterAttempts: attempts, elapsedMs: Number((performance.now() - started).toFixed(3)) }));
  console.log(JSON.stringify({ before: before.overall, after: after.overall }));
} catch (error) {
  await receipt.writeFile(asciiJSON({ ...environment, status: 'INTERRUPTED_OR_FAILED', adapterAttempts: attempts,
    reason: 'PILOT_EXECUTION_FAILED', elapsedMs: Number((performance.now() - started).toFixed(3)) }));
  throw error;
} finally { await journal.close(); await receipt.close(); }
