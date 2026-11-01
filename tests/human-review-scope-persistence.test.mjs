import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPairDecision } from '../src/opportunity-state.mjs';
import { pairDigest, resolveHumanDecision } from '../src/semantic-review.mjs';

test('lossy sparse scope IDs do not become valid after JSON persistence', () => {
  const a = { id: 'a', persona: 'Reviewers', jobToBeDone: 'Check invoices' };
  const b = { ...a, id: 'b', jobToBeDone: 'Reconcile source bills' };
  const event = recordPairDecision(a, b, { digest: pairDigest(a, b), decision: 'same',
    actor: 'SYNTHETIC_REVIEWER', reason: 'Scope persistence contract', recordedAt: '2026-11-01T00:00:00Z' });
  for (const ids of [Array(2), [, 'b'], ['a', ,]]) {
    const malformed = { ...event, recordScope: { ...event.recordScope, ids } };
    assert.equal(resolveHumanDecision(a, b, [malformed]), null);
    assert.equal(resolveHumanDecision(a, b, [JSON.parse(JSON.stringify(malformed))]), null);
  }
});
