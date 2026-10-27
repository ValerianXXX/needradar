// Synthetic, authored labels. Unicode escapes keep public source prose English.
const en = { title: 'Review uncertain invoice text', persona: 'Finance operations teams',
  jobToBeDone: 'Route uncertain invoice OCR fields to a human reviewer with source image coordinates', evidenceKeys: ['original-a'] };
const zh = { title: '\u5ba1\u6838\u53d1\u7968\u8bc6\u522b\u7ed3\u679c', persona: '\u8d22\u52a1\u8fd0\u8425\u56e2\u961f',
  jobToBeDone: '\u5c06\u4e0d\u786e\u5b9a\u7684\u53d1\u7968\u8bc6\u522b\u5b57\u6bb5\u4ea4\u7ed9\u4eba\u5de5\u5ba1\u6838\uff0c\u5e76\u4fdd\u7559\u539f\u59cb\u56fe\u7247\u5750\u6807', evidenceKeys: ['original-b'] };
const pair = (id, category, left, right, expected) => ({ id, category, left, right, expected });
export const cases = [
  pair('same-new-evidence', 'different_evidence', en, { ...en, evidenceKeys: ['independent-c'] }, 'same'),
  pair('same-chinese', 'chinese', zh, { ...zh, evidenceKeys: ['independent-d'] }, 'same'),
  pair('same-bilingual', 'cross_language', en, zh, 'same'),
  pair('same-paraphrase', 'low_overlap', en, { title: 'Escalate doubtful bill transcription', persona: 'Finance operations teams',
    jobToBeDone: 'Have a person check ambiguous supplier bill characters against their original pixel locations', evidenceKeys: ['independent-e'] }, 'same'),
  pair('same-repost', 'repost', en, { ...en, evidenceKeys: ['original-a'] }, 'same'),
  pair('same-case', 'normalization', en, { ...en, title: en.title.toUpperCase(), evidenceKeys: [] }, 'same'),
  pair('different-job', 'same_persona', en, { ...en, title: 'Forecast cash flow', jobToBeDone: 'Predict next month cash balance from paid invoices' }, 'different'),
  pair('different-constraints', 'constraints', { ...en, constraints: { processing: 'offline' } }, { ...en, constraints: { processing: 'cloud' } }, 'different'),
  pair('different-budget', 'constraints', { ...en, constraints: { monthlyBudgetUsd: 0 } }, { ...en, constraints: { monthlyBudgetUsd: 500 } }, 'different'),
  pair('different-timing', 'constraints', { ...en, constraints: { latency: 'realtime' } }, { ...en, constraints: { latency: 'overnight' } }, 'different'),
  pair('nearby-need', 'nearby_nonduplicate', en, { ...en, title: 'Archive invoice images', jobToBeDone: 'Archive invoice source images and coordinates for audit retention without OCR review' }, 'different'),
  pair('negated-task', 'negation', en, { ...en, jobToBeDone: 'Do not route uncertain invoice OCR fields to humans; reject the invoice automatically' }, 'different'),
  pair('same-evidence-different-job', 'evidence_not_identity', en, { ...en, title: 'Detect duplicate payments', jobToBeDone: 'Find duplicate vendor payments in bank transactions' }, 'different'),
  pair('different-user', 'same_task_different_persona', en, { ...en, persona: 'Individual consumers disputing personal utility bills' }, 'different'),
  pair('unrelated', 'unrelated', en, { title: 'Index migration consistency', persona: 'Search engineers', jobToBeDone: 'Reconcile vector index state during storage migration', evidenceKeys: ['vector'] }, 'different'),
  pair('chinese-different-job', 'chinese_nonduplicate', zh, { ...zh, jobToBeDone: '\u9884\u6d4b\u4e0b\u4e2a\u6708\u7684\u73b0\u91d1\u6d41\u91cf' }, 'different'),
];
