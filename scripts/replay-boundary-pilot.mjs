import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluate } from './evaluate-boundaries.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';
import { fixtureHash } from '../eval/boundaries-v2/load.mjs';

const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const receiptPath = argument('--receipt'), journalPath = argument('--journal'), output = argument('--output');
if (!receiptPath || !journalPath || !output) throw new Error('RECEIPT_JOURNAL_AND_FRESH_OUTPUT_REQUIRED');
const receiptText = await readFile(receiptPath, 'utf8'), journalText = await readFile(journalPath, 'utf8');
if (Buffer.byteLength(receiptText) > 1000000 || Buffer.byteLength(journalText) > 2000000) throw new Error('REPLAY_SIZE_LIMIT');
const receipt = JSON.parse(receiptText), entries = journalText.trim().split(/\r?\n/u).map(line => JSON.parse(line));
if (receipt.status !== 'COMPLETED_OBSERVATION' || !receipt.syntheticOnly || receipt.pilot?.fixtureHash !== fixtureHash
  || receipt.adapterAttempts !== 12 || entries.length !== 24) throw new Error('COMPLETE_FIXED_PILOT_REQUIRED');
const responses = new Map();
for (let index = 0; index < entries.length; index += 2) {
  const start = entries[index], end = entries[index + 1];
  if (start.type !== 'REQUEST_STARTED' || end.type !== 'RESPONSE' || start.ordinal !== index / 2 + 1
    || end.ordinal !== start.ordinal || end.response?.toolCalls !== 0) throw new Error('MATCHED_NO_TOOL_RESPONSES_REQUIRED');
  const key = JSON.stringify(start.request);
  if (responses.has(key)) throw new Error('UNIQUE_REQUESTS_REQUIRED');
  responses.set(key, end.response);
}
let calls = 0;
const result = await evaluate({ reviewer: async request => {
  const key = JSON.stringify(request), response = responses.get(key);
  if (!response) throw new Error('NO_EXACT_RECORDED_REQUEST');
  responses.delete(key);
  calls++;
  return response;
}, maxModelCalls: 12, selectedIds: receipt.pilot.selectedIds });
if (responses.size || calls !== 12) throw new Error('REPLAY_INCOMPLETE');
const hash = value => createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex');
const files = ['src/similarity.mjs', 'src/semantic-review.mjs', 'src/timestamps.mjs', 'scripts/evaluate-boundaries.mjs', 'scripts/replay-boundary-pilot.mjs'];
await writeFile(output, asciiJSON({ observedAt: new Date().toISOString(), mode: 'RECORDED_REAL_OUTPUT_REPLAY', syntheticOnly: true,
  liveProviderCalls: 0, replayedResponses: calls, originalReceiptLFHash: hash(receiptText), originalJournalLFHash: hash(journalText),
  sourceLFHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(file, 'utf8'))]))),
  notes: 'Replay tests current local decisions. It is not a second live model observation; model timing and unknown usage/cost belong to the original receipt.',
  result: { ...result, mode: 'RECORDED_REAL_OUTPUT_REPLAY' } }), { flag: 'wx' });
console.log(JSON.stringify(result.overall));
