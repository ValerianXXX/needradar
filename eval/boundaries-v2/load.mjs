import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const fixtureHash = '5b4b8c0ca22c0a28d95d02622714838bdcef0dc3cc3a0fcee536a7e40e6b1cb9';
export async function loadFixtures() {
  const raw = (await readFile(new URL('./cases.json', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  if (createHash('sha256').update(raw).digest('hex') !== fixtureHash) throw new Error('FROZEN_BOUNDARIES_CHANGED');
  const value = JSON.parse(raw);
  if (value.syntheticOnly !== true || value.cases.length !== 140 || new Set(value.cases.map(row => row.id)).size !== 140) {
    throw new Error('INVALID_BOUNDARY_POPULATION');
  }
  return value;
}
