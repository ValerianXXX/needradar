import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const seedHash = '68ece80ad50f9d0409432b46a8933cf8f961870f1e502fadc76841800458139a';
export const categories = ['different_evidence', 'cross_language', 'low_overlap', 'same_persona_different_task',
  'same_task_different_constraint', 'repost_same_origin', 'nearby_distinct'];
export const asciiJSON = value => JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
const copy = value => structuredClone(value);

export function buildCases(seeds) {
  return seeds.domains.flatMap((seed, index) => {
    const observation = (key, extra = {}) => ({ evidenceKey: key, authorGroup: `author-${key}`, sourcePolicy: `policy-${seed.id}`,
      sourceAccessible: true, containsPersonalData: false, rightsApproved: true, ...extra });
    const left = { id: `${seed.id}-left`, title: seed.title, persona: seed.persona, jobToBeDone: seed.task,
      desiredOutcome: 'A reviewable result preserving source evidence.', constraints: { processing: 'offline', humanReview: 'required' },
      evidenceKeys: [`${seed.id}-original`] };
    const chinese = { ...copy(left), title: seed.taskZh, persona: seed.personaZh, jobToBeDone: seed.taskZh,
      desiredOutcome: '\u4fdd\u7559\u6765\u6e90\u8bc1\u636e\u7684\u53ef\u590d\u6838\u7ed3\u679c\u3002' };
    const pair = (category, a, b, expected, rationale, extra = {}) => ({
      id: `${seed.id}--${category}`, domain: seed.id, split: seed.split, category,
      left: copy(a), right: { ...copy(b), id: `${seed.id}-right-${category}` }, expected, rationale, ...extra,
    });
    const identical = index % 2 ? chinese : left;
    const constraints = [ ['processing', 'offline', 'cloud'], ['humanReview', 'required', 'forbidden'],
      ['monthlyBudgetUsd', 0, 300], ['latency', 'immediate', 'next_day'],
      ['dataResidency', 'local_device', 'external_region'], ['authorization', 'user_present', 'unattended'] ][index % 6];
    const original = observation(`${seed.id}-original`, { url: `https://evidence.example.test/${seed.id}/original` });
    return [
      pair('different_evidence', identical, { ...identical, title: 'Alternative presentation', evidenceKeys: [`${seed.id}-independent`] }, 'same',
        'The task, user, outcome and constraints are identical; title and evidence identity do not change the opportunity.'),
      pair('cross_language', left, { ...chinese, evidenceKeys: [`${seed.id}-translation-source`] }, 'same',
        'Authored English and Chinese descriptions express the same bounded workflow.'),
      pair('low_overlap', left, { ...left, title: 'Alternative workflow description', jobToBeDone: seed.paraphrase, evidenceKeys: [`${seed.id}-paraphrase-source`] }, 'same',
        'Different wording describes the same user action and evidence-preserving result.'),
      pair('same_persona_different_task', left, { ...left, title: 'Another responsibility', jobToBeDone: seed.otherTask }, 'different',
        'The persona is shared, but the operation and object of the task differ.'),
      pair('same_task_different_constraint', { ...left, constraints: { ...left.constraints, [constraints[0]]: constraints[1] } },
        { ...left, constraints: { ...left.constraints, [constraints[0]]: constraints[2] } }, 'different',
        'One explicit material operating constraint is incompatible.'),
      pair('repost_same_origin', left, { ...left, evidenceKeys: [`${seed.id}-repost`] }, 'same',
        'Repeated captures and reposts describe the same opportunity and one independent origin.',
        { observations: [original, copy(original), observation(`${seed.id}-repost`, { repostOf: original.evidenceKey }),
          observation(`${seed.id}-mirror`, { originalUrl: original.url })], expectedIndependentEvidence: 1 }),
      pair('nearby_distinct', left, { ...left, title: 'Related but distinct workflow', jobToBeDone: seed.nearbyTask }, 'different',
        'Related objects or vocabulary do not make a different action, boundary or outcome the same task.'),
    ];
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('FRESH_OUTPUT_REQUIRED');
  const raw = (await readFile(new URL('../eval/boundaries-v2/seeds.json', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  if (createHash('sha256').update(raw).digest('hex') !== seedHash) throw new Error('FROZEN_SEEDS_CHANGED');
  const seeds = JSON.parse(raw), cases = buildCases(seeds);
  if (cases.length !== 140 || categories.some(category => cases.filter(row => row.category === category).length !== 20)) {
    throw new Error('BOUNDARY_POPULATION_MISMATCH');
  }
  const result = { version: 'NEEDRADAR_BOUNDARIES_V2', frozenOn: '2026-10-29', syntheticOnly: true, seedHash,
    authorship: seeds.authorship, splitRule: 'First twelve domains development; remaining eight designated held-out. All seven variants stay together.',
    limits: 'Authored synthetic tasks with shared category transformations; not independently blind or representative market evidence.', categories, cases };
  const encoded = asciiJSON(result);
  await writeFile(process.argv[outputIndex + 1], encoded, { flag: 'wx' });
  console.log(JSON.stringify({ cases: cases.length, sha256: createHash('sha256').update(encoded).digest('hex') }));
}
