import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLocalEncoder } from '../src/local-encoder.mjs';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
if (!output || process.env.NEEDRADAR_ALLOW_LOCAL_ENCODER !== 'true') throw new Error('EXPLICIT_LOCAL_PROFILE_REQUIRED');
const receipt = await open(output, 'wx'), fixtures = await loadFixtures();
const target = fixtures.cases.find(row => row.id === 'invoice--cross_language');
const distractor = fixtures.cases.find(row => row.id === 'invoice--nearby_distinct').right;
const files = ['src/local-encoder.mjs', 'scripts/local-embed.py', 'src/embedding-contract.mjs', 'scripts/profile-local-encoder.mjs'];
const sourceLFHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
  createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
const observations = [];
try {
  for (const size of [100, 1000, 10000]) {
    console.log(JSON.stringify({ size, stage: 'CHILD_MEMORY_PROFILE_STARTED' }));
    const drafts = Array.from({ length: size - 1 }, (_, index) => ({ ...distractor, id: `synthetic-${index}`,
      jobToBeDone: `${distractor.jobToBeDone} Reference queue ${index}.` }));
    drafts.push({ ...target.right, id: 'expected-target' });
    const encode = createLocalEncoder({ pythonExecutable: process.env.NEEDRADAR_ENCODER_PYTHON,
      modelDirectory: process.env.NEEDRADAR_ENCODER_MODEL_DIR, allowExecution: true, threads: 2 });
    global.gc?.();
    const before = process.memoryUsage(), result = await encode(drafts);
    observations.push({ size, encoding: result.observation, nodeMemoryBefore: before, nodeMemoryAfter: process.memoryUsage() });
    console.log(JSON.stringify({ size, childPeakRssBytes: result.observation.memory?.peakRssBytes ?? null }));
  }
  await receipt.writeFile(asciiJSON({ observedAt: new Date().toISOString(), status: 'COMPLETED_OBSERVATION', syntheticOnly: true,
    fixtureHash, sourceLFHashes, cloudRequests: 0, observations,
    scope: 'Separate fresh encoder process per size; Python peak RSS and Node snapshots. Their sum is not a synchronized whole-system peak.' }));
} finally { await receipt.close(); }
