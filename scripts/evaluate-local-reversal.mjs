import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLocalEncoder } from '../src/local-encoder.mjs';
import { createSemanticCandidateIndex, retrieveSemanticCandidates } from '../src/semantic-retrieval.mjs';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
if (!output || process.env.NEEDRADAR_ALLOW_LOCAL_ENCODER !== 'true') throw new Error('EXPLICIT_REVERSAL_EVALUATION_REQUIRED');
const receipt = await open(output, 'wx'), fixtures = await loadFixtures();
const encode = createLocalEncoder({ pythonExecutable: process.env.NEEDRADAR_ENCODER_PYTHON,
  modelDirectory: process.env.NEEDRADAR_ENCODER_MODEL_DIR, allowExecution: true, threads: 2 });
const sources = ['src/local-encoder.mjs', 'scripts/local-embed.py', 'src/embedding-contract.mjs', 'src/semantic-retrieval.mjs', 'scripts/evaluate-local-reversal.mjs'];
const sourceLFHashes = Object.fromEntries(await Promise.all(sources.map(async file => [file,
  createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
try {
  const observations = [], encoding = [];
  for (const reverse of [false, true]) {
    const corpus = fixtures.cases.map(item => ({ ...item[reverse ? 'left' : 'right'], id: `target-${item.id}` }));
    const queries = fixtures.cases.map(item => item[reverse ? 'right' : 'left']);
    const corpusEmbeddings = await encode(corpus), queryEmbeddings = await encode(queries);
    encoding.push({ reverse, corpus: corpusEmbeddings.observation, queries: queryEmbeddings.observation });
    const index = createSemanticCandidateIndex(corpus, corpusEmbeddings);
    const reversedIndex = createSemanticCandidateIndex([...corpus].reverse(), { ...corpusEmbeddings, rows: [...corpusEmbeddings.rows].reverse() });
    for (let i = 0; i < fixtures.cases.length; i++) {
      const options = { queryEmbedding: queryEmbeddings.rows[i] }, item = fixtures.cases[i];
      const first = retrieveSemanticCandidates(queries[i], index, options).rows.map(row => row.existing.id);
      const second = retrieveSemanticCandidates(queries[i], index, options).rows.map(row => row.existing.id);
      const reordered = retrieveSemanticCandidates(queries[i], reversedIndex, options).rows.map(row => row.existing.id);
      const target = first.indexOf(`target-${item.id}`);
      observations.push({ id: item.id, category: item.category, split: item.split, expected: item.expected, reverse,
        pairedTargetRank: target < 0 ? null : target + 1, repeatStable: JSON.stringify(first) === JSON.stringify(second),
        inputOrderStable: JSON.stringify(first) === JSON.stringify(reordered) });
    }
  }
  const summarize = rows => ({ pairs: rows.length,
    duplicateTargetMisses: rows.filter(row => row.expected === 'same' && row.pairedTargetRank === null).length,
    allPairedTargetMisses: rows.filter(row => row.pairedTargetRank === null).length,
    repeatDisagreements: rows.filter(row => !row.repeatStable).length,
    inputOrderDisagreements: rows.filter(row => !row.inputOrderStable).length });
  const summary = { forward: summarize(observations.filter(row => !row.reverse)), reverse: summarize(observations.filter(row => row.reverse)) };
  await receipt.writeFile(asciiJSON({ observedAt: new Date().toISOString(), status: 'COMPLETED_OBSERVATION', syntheticOnly: true,
    fixtureHash, sourceLFHashes, encoding, summary, observations, cloudInferenceRequests: 0,
    scope: 'Direction tests use separately indexed counterpart corpora; repeat/order checks compare candidate IDs, not transient array positions. No semantic adjudication or independent holdout.' }));
  console.log(JSON.stringify(summary));
} finally { await receipt.close(); }
