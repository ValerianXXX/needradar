import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createCandidateIndex, retrieveCandidates } from '../src/similarity.mjs';
import { createSemanticCandidateIndex, retrieveSemanticCandidates } from '../src/semantic-retrieval.mjs';
import { createLocalEncoder } from '../src/local-encoder.mjs';
import { encoderId, encoderSpec } from '../src/embedding-contract.mjs';
import { reviewDuplicates } from '../src/semantic-review.mjs';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
const mode = process.argv.includes('--scale') ? 'scale' : 'pairs';
if (!output || process.env.NEEDRADAR_ALLOW_LOCAL_ENCODER !== 'true') throw new Error('EXPLICIT_LOCAL_EVALUATION_REQUIRED');
const settings = { pythonExecutable: process.env.NEEDRADAR_ENCODER_PYTHON, modelDirectory: process.env.NEEDRADAR_ENCODER_MODEL_DIR,
  allowExecution: true, threads: 2 };
const fixtures = await loadFixtures();
const planText = (await readFile(new URL('../eval/boundaries-v2/retrieval-plan-v2.json', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const plan = JSON.parse(planText);
if (plan.fixtureHash !== fixtureHash || plan.retrievalLimit !== 32 || plan.revision !== encoderSpec.revision) throw new Error('FROZEN_RETRIEVAL_PLAN_REQUIRED');
const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const files = ['src/similarity.mjs', 'src/semantic-review.mjs', 'src/semantic-retrieval.mjs', 'src/embedding-contract.mjs',
  'src/local-encoder.mjs', 'src/pipeline.mjs', 'scripts/local-embed.py', 'scripts/evaluate-local-retrieval.mjs', 'config/local-encoder.json'];
const base = { observedAt: new Date().toISOString(), protocol: 'LOCAL_RETRIEVAL_OBSERVATION_V1', mode, syntheticOnly: true,
  fixtureHash, planLFHash: hash(planText), encoderId, encoder: encoderSpec, node: process.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), workingTreeObservation: true,
  sourceLFHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(file, 'utf8'))]))),
  cloudInferenceRequests: 0, paidApiCostUsd: 0, machineEnergyCost: null, llmAdjudicationCalls: 0,
  limits: 'Authored fixtures, not independent blind validation. Shared host; process memory snapshots, not peak or per-query allocation. Dense scores never establish identity.' };
const receipt = await open(output, 'wx');
const started = performance.now();
const observations = [];
const rankIn = (retrieval, id) => { const index = retrieval.rows.findIndex(row => row.existing.id === id); return index < 0 ? null : index + 1; };
const summary = rows => ({ pairs: rows.length,
  duplicatePairs: rows.filter(row => row.expected === 'same').length,
  lexicalDuplicateTargetMisses: rows.filter(row => row.expected === 'same' && row.lexicalRank === null).length,
  hybridDuplicateTargetMisses: rows.filter(row => row.expected === 'same' && row.hybridRank === null).length,
  lexicalAllPairedTargetMisses: rows.filter(row => row.lexicalRank === null).length,
  hybridAllPairedTargetMisses: rows.filter(row => row.hybridRank === null).length,
  defaultBudgetCanReachDuplicateTarget: rows.filter(row => row.expected === 'same' && row.withinDefaultReviewBudget).length,
  falseSamePairedProposals: rows.filter(row => row.expected === 'different' && row.pairedVerdict === 'same').length,
  duplicatePairedProposalsDecidedDifferent: rows.filter(row => row.expected === 'same' && row.pairedVerdict === 'different').length,
  unresolvedDuplicatePairedProposals: rows.filter(row => row.expected === 'same' && ['uncertain', 'not_retrieved'].includes(row.pairedVerdict)).length,
  unresolvedPairedProposals: rows.filter(row => ['uncertain', 'not_retrieved'].includes(row.pairedVerdict)).length });
try {
  if (mode === 'pairs') {
    const encode = createLocalEncoder(settings), corpus = fixtures.cases.map(row => row.right);
    const corpusEncoding = await encode(corpus), queryEncoding = await encode(fixtures.cases.map(row => row.left));
    const lexical = createCandidateIndex(corpus), index = createSemanticCandidateIndex(corpus, corpusEncoding);
    for (let itemIndex = 0; itemIndex < fixtures.cases.length; itemIndex++) {
      const item = fixtures.cases[itemIndex], queryEmbedding = queryEncoding.rows[itemIndex];
      const before = retrieveCandidates(item.left, lexical), after = retrieveSemanticCandidates(item.left, index, { queryEmbedding });
      const hybridRank = rankIn(after, item.right.id);
      const target = hybridRank === null ? null : after.rows[hybridRank - 1];
      const reviewed = await reviewDuplicates(item.left, index, { queryEmbedding, maxModelCalls: 0 });
      const paired = target ? reviewed.reviews.find(row => row.index === target.index) : null;
      const callsNeeded = hybridRank === null ? null : after.rows.slice(0, hybridRank).filter(row => !row.autoDuplicate && !row.constraints.conflicts.length).length;
      observations.push({ id: item.id, category: item.category, split: item.split, expected: item.expected,
        lexicalRank: rankIn(before, item.right.id), hybridRank, withinDefaultReviewBudget: callsNeeded !== null && callsNeeded <= 8,
        precedingAmbiguousPairs: callsNeeded, pairedVerdict: paired?.verdict ?? 'not_retrieved', pairedMethod: paired?.method ?? null,
        selected: after.rows.length, retrievalComplete: after.complete,
        targetEvidence: target?.retrievalEvidence ?? null, automaticMerge: reviewed.automaticMerge });
    }
    const result = { ...base, status: 'COMPLETED_OBSERVATION', encoding: { corpus: corpusEncoding.observation, queries: queryEncoding.observation },
      overall: summary(observations), byCategory: Object.fromEntries(fixtures.categories.map(category => [category, summary(observations.filter(row => row.category === category))])),
      bySplit: Object.fromEntries(['development', 'held_out'].map(split => [split, summary(observations.filter(row => row.split === split))])),
      observations, elapsedMs: performance.now() - started, processMemoryAfter: process.memoryUsage() };
    await receipt.writeFile(asciiJSON(result));
    console.log(JSON.stringify(result.overall));
  } else {
    for (const size of plan.scaleSizes) for (const id of plan.scaleQueries) {
      console.log(JSON.stringify({ size, query: id, stage: 'ENCODING_STARTED' }));
      const item = fixtures.cases.find(row => row.id === id);
      const distractor = fixtures.cases.find(row => row.domain === item.domain && row.category === 'nearby_distinct').right;
      const corpus = Array.from({ length: size - 1 }, (_, index) => ({ ...distractor, id: `synthetic-${index}`,
        jobToBeDone: `${distractor.jobToBeDone} Reference queue ${index}.` }));
      corpus.push({ ...item.right, id: 'expected-target' });
      const encode = createLocalEncoder(settings); // Fresh process/cache per scenario.
      global.gc?.();
      const memoryBefore = process.memoryUsage(), buildStart = performance.now();
      const encoded = await encode(corpus), index = createSemanticCandidateIndex(corpus, encoded);
      const buildMs = performance.now() - buildStart;
      const queryEncoded = await encode([item.left]);
      const lexical = createCandidateIndex(corpus);
      for (let repeat = 0; repeat < plan.scaleRepeats; repeat++) {
        const beforeStart = performance.now(), before = retrieveCandidates(item.left, lexical), lexicalMs = performance.now() - beforeStart;
        const afterStart = performance.now(), after = retrieveSemanticCandidates(item.left, index, { queryEmbedding: queryEncoded.rows[0] });
        observations.push({ size, queryId: id, repeat, lexicalQueryMs: lexicalMs, hybridQueryMs: performance.now() - afterStart,
          indexBuildIncludingEncodingMs: buildMs, queryEncoding: queryEncoded.observation, corpusEncoding: encoded.observation,
          lexicalTargetRank: rankIn(before, 'expected-target'), hybridTargetRank: rankIn(after, 'expected-target'),
          selected: after.rows.length, complete: after.complete, memoryBefore, memoryAfter: process.memoryUsage() });
      }
      console.log(JSON.stringify({ size, query: id, stage: 'MEASURED', targetRank: observations.at(-1).hybridTargetRank,
        buildMs: Number(buildMs.toFixed(2)) }));
    }
    await receipt.writeFile(asciiJSON({ ...base, status: 'COMPLETED_OBSERVATION', observations, elapsedMs: performance.now() - started }));
  }
} catch (error) {
  await receipt.writeFile(asciiJSON({ ...base, status: 'FAILED_OBSERVATION', observations,
    error: /^[A-Z_]+$/u.test(error.message) ? error.message : 'EVALUATION_FAILED', elapsedMs: performance.now() - started }));
  throw error;
} finally { await receipt.close(); }
