import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDuplicates } from '../src/semantic-review.mjs';

test('supported null-prototype records and constraints do not appear edited after cloning', async () => {
  const sample = { title: 'Review fields', persona: 'Document operators', jobToBeDone: 'Review invoice fields',
    desiredOutcome: 'Verified fields', constraints: { processing: 'offline' } };
  for (const field of ['candidate', 'peer', 'constraints']) {
    const candidate = structuredClone(sample), peer = structuredClone(sample);
    Object.setPrototypeOf(field === 'candidate' ? candidate : field === 'peer' ? peer : candidate.constraints, null);
    const result = await reviewDuplicates(candidate, [peer], { maxModelCalls: 0 });
    assert.equal(result.requiresReview, false, field);
    assert.equal(result.duplicate, true, field);
    assert.equal(result.inputChanged, false, field);
    assert.equal(result.modelCalls, 0);
  }
});
