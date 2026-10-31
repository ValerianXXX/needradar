// Read the closed historical plan. This grants no permission to invoke a provider.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';

export const recordedProtocolHash = '6c9f344cc80580ad1c611d92de659ab7570b9fd979e84afed4cf7de088a17267';
export const recordedRunnerHash = 'dda764caa6472c50fa22fb3c8580adbc70294fc5fca0cd3f686c2e07d12df5aa';
const hash = text => createHash('sha256').update(text).digest('hex');
const readLF = async relative => (await readFile(new URL(relative, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

export async function readFrozenFollowupPlan() {
  const text = await readLF('../eval/targeted-followup-v1/plan.json');
  if (hash(text) !== recordedProtocolHash) throw new Error('FOLLOWUP_PROTOCOL_CHANGED');
  const plan = JSON.parse(text), fixtures = await loadFixtures();
  const observation = await readLF('../eval/results/2026-10-29-local-retrieval-pairs.json');
  if (plan.protocol !== 'TARGETED_SEMANTIC_FOLLOWUP_V1' || plan.fixtureHash !== fixtureHash
      || plan.maxAdapterAttempts !== 14 || plan.maxNewCallsPerInvocation !== 7 || plan.stopAfterFailures !== 2
      || hash(observation) !== plan.retrievalObservationLFHash) throw new Error('FOLLOWUP_PROTOCOL_INVALID');
  const targets = JSON.parse(observation).observations.filter(row => row.expected === 'same' && !row.withinDefaultReviewBudget);
  const ids = targets.flatMap(row => [row.id, row.id.split('--')[0] + '--nearby_distinct']);
  if (ids.length !== 14 || new Set(ids).size !== 14 || JSON.stringify(ids) !== JSON.stringify(plan.selectedIds)) throw new Error('FOLLOWUP_SELECTION_CHANGED');
  const cases = ids.map(id => fixtures.cases.find(row => row.id === id));
  if (cases.some(row => !row) || cases.filter(row => row.expected === 'same').length !== 7) throw new Error('FOLLOWUP_FIXTURE_MISSING');
  return { plan, cases, protocolHash: recordedProtocolHash, recordedRunnerHash };
}
