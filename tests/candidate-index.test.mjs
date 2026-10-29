import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateIndex, retrieveCandidates, findLikelyDuplicate } from '../src/similarity.mjs';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { buildCases, asciiJSON } from '../scripts/build-boundary-fixtures.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('known exact identity survives a large high-overlap lexical shortlist', () => {
  const left = { id: 'query', title: 'Source document review', persona: 'Reviewers',
    jobToBeDone: 'Review uncertain supplier invoice fields against original images', desiredOutcome: 'Audited fields', constraints: {} };
  const target = { ...left, id: 'target', title: 'Another presentation' };
  const distractors = Array.from({ length: 100 }, (_, index) => ({ ...left, id: `d-${index}`,
    jobToBeDone: 'Review uncertain supplier invoice fields against original contracts' }));
  for (const corpus of [[...distractors, target], createCandidateIndex([...distractors, target])]) {
    assert.equal(findLikelyDuplicate(left, corpus).duplicate, true);
    assert.equal(retrieveCandidates(left, corpus).rows.some(row => row.existing.id === 'target'), true);
  }
});

test('frozen corpus contains twenty pairs in each of seven categories with domain isolation', async () => {
  const fixture = await loadFixtures();
  for (const category of fixture.categories) assert.equal(fixture.cases.filter(row=>row.category===category).length,20);
  for (const domain of new Set(fixture.cases.map(row=>row.domain))) {
    assert.equal(new Set(fixture.cases.filter(row=>row.domain===domain).map(row=>row.split)).size,1);
  }
  const seeds=JSON.parse(await readFile(new URL('../eval/boundaries-v2/seeds.json',import.meta.url),'utf8'));
  assert.deepEqual(buildCases(seeds), fixture.cases);
  assert.equal(createHash('sha256').update(asciiJSON(fixture)).digest('hex'),fixtureHash);
});

test('indexed and uncached retrieval agree on all fixed pairs without claiming semantic quality', async () => {
  for (const row of (await loadFixtures()).cases) {
    const index=createCandidateIndex([row.right]);
    const cached=retrieveCandidates(row.left,index), direct=retrieveCandidates(row.left,[row.right]);
    assert.deepEqual(cached.rows,direct.rows,row.id);
    assert.equal(findLikelyDuplicate(row.left,index).duplicate,findLikelyDuplicate(row.left,[row.right]).duplicate);
    assert.equal(cached.snapshotDigest,index.snapshotDigest);
  }
});

test('an index is immutable, omits raw evidence and must be rebuilt for source changes', async () => {
  const row=(await loadFixtures()).cases[0], item=structuredClone(row.right);
  item.observations=[{privateFixtureText:'Not an index field'}];
  const index=createCandidateIndex([item]);
  item.jobToBeDone='Changed after indexing';
  const found=retrieveCandidates(row.left,index).rows[0].existing;
  assert.equal(found.jobToBeDone,row.right.jobToBeDone);
  assert.equal(found.observations,undefined);
  assert.throws(()=>{found.constraints.processing='cloud';});
  assert.notEqual(createCandidateIndex([item]).snapshotDigest,index.snapshotDigest);
});

test('stable IDs resolve lexical ties while incomplete retrieval remains visible', () => {
  const rows=Array.from({length:70},(_,index)=>({id:`item-${String(index).padStart(3,'0')}`,persona:'Reviewers',jobToBeDone:'Review records',title:'Records'}));
  const query=rows[0];
  const a=retrieveCandidates(query,createCandidateIndex(rows),{limit:3}), b=retrieveCandidates(query,createCandidateIndex([...rows].reverse()),{limit:3});
  assert.deepEqual(a.rows.map(row=>row.existing.id),b.rows.map(row=>row.existing.id));
  assert.equal(a.complete,false);
  assert.equal(a.total,70);
  assert.throws(()=>createCandidateIndex([rows[0],rows[0]]));
  assert.throws(()=>createCandidateIndex([{...rows[0],constraints:{bad:[]}}]));
  assert.throws(()=>createCandidateIndex(Array(10001).fill(rows[0])));
});
