import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceSummary } from '../src/provenance.mjs';
import { independentEvidenceChange } from '../src/evidence-independence.mjs';

const row = (evidenceKey, authorGroup, extra = {}) => ({ evidenceKey, authorGroup, ...extra });
const change = (before, after) => independentEvidenceChange(
  evidenceSummary(before), evidenceSummary(structuredClone(after)), new Set(before));

test('correcting a known author on the same retained capture is neither arrival nor loss', () => {
  assert.deepEqual(change([row('a', 'old')], [row('a', 'corrected')]),
    { added: 0, resolvedExisting: 1, consolidatedOrLost: 0 });
});

test('relabeling both known author and organization preserves the existing unit', () => {
  assert.deepEqual(change([row('a', 'old', { originGroup: 'old-org' })],
    [row('a', 'corrected', { originGroup: 'corrected-org' })]),
  { added: 0, resolvedExisting: 1, consolidatedOrLost: 0 });
});

test('resolving an unattributed capture after serialization does not create an arrival', () => {
  assert.deepEqual(change([{ evidenceKey: 'a' }], [row('a', 'resolved')]),
    { added: 0, resolvedExisting: 1, consolidatedOrLost: 0 });
});

test('source URL identity survives an adapter key correction and attribution change', () => {
  assert.deepEqual(change([row('old-key', 'old', { url: 'https://example.invalid/post/1#comment-a' })],
    [row('new-key', 'corrected', { url: 'https://example.invalid/post/1?utm_source=sample#comment-a' })]),
  { added: 0, resolvedExisting: 1, consolidatedOrLost: 0 });
});

test('collapsing two retained units reports exactly one consolidation', () => {
  assert.deepEqual(change([row('a', 'a'), row('b', 'b')],
    [row('a', 'corrected-a', { originGroup: 'shared' }), row('b', 'corrected-b', { originGroup: 'shared' })]),
  { added: 0, resolvedExisting: 1, consolidatedOrLost: 1 });
});

test('splitting an old unit is attribution resolution rather than fresh demand', () => {
  assert.deepEqual(change([row('a', 'shared'), row('b', 'shared')], [row('a', 'a'), row('b', 'b')]),
    { added: 0, resolvedExisting: 2, consolidatedOrLost: 0 });
});

test('a split cannot conceal the simultaneous loss of a different old unit', () => {
  const before = [row('a', 'shared'), row('b', 'shared'), row('c', 'independent')];
  const after = [row('a', 'shared'), row('b', 'corrected'), { evidenceKey: 'c' }];
  assert.deepEqual(change(before, after), { added: 0, resolvedExisting: 1, consolidatedOrLost: 1 });
});

test('overlapping corrections match retained units without greedy or input-order losses', () => {
  const before = [row('a', 'shared'), row('b', 'shared'), row('c', 'independent')];
  const after = [row('a', 'new-a', { originGroup: 'new-shared' }), row('b', 'new-b'),
    row('c', 'new-c', { originGroup: 'new-shared' })];
  for (const previous of [before, [...before].reverse()]) {
    for (const current of [after, [...after].reverse(), [after[1], after[2], after[0]]]) {
      assert.deepEqual(change(previous, current), { added: 0, resolvedExisting: 2, consolidatedOrLost: 0 });
    }
  }
});

test('a genuinely new unrelated capture remains new alongside an existing correction', () => {
  assert.deepEqual(change([row('a', 'old')], [row('a', 'corrected'), row('new', 'independent')]),
    { added: 1, resolvedExisting: 1, consolidatedOrLost: 0 });
});

test('same author recaptures remain dependent while distinct comment anchors remain distinct', () => {
  const before = [row('a', 'one', { url: 'https://example.invalid/thread#one' })];
  assert.deepEqual(change(before, [...before, row('b', 'one')]),
    { added: 0, resolvedExisting: 0, consolidatedOrLost: 0 });
  assert.deepEqual(change(before, [...before, row('b', 'two', { url: 'https://example.invalid/thread#two' })]),
    { added: 1, resolvedExisting: 0, consolidatedOrLost: 0 });
});
