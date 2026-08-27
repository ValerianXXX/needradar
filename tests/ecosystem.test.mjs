import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('project registry contains only the personal public portfolio', async () => {
  const registry = JSON.parse(await readFile(new URL('data/project-registry.json', root), 'utf8'));
  assert.equal(registry.schemaVersion, '1.0.0');
  assert.deepEqual(registry.projects.map((project) => project.id), [
    'needradar',
    'ai-skill-product-discovery',
    'billfit',
    'from-feed-to-agent',
    'jobflow',
  ]);
  assert.ok(registry.projects.every((project) => project.runtimeDependency === false));
});

test('connection schemas preserve manual decisions and non-circular evidence', async () => {
  const handoff = JSON.parse(await readFile(new URL('schemas/opportunity-handoff-v1.schema.json', root), 'utf8'));
  const connection = JSON.parse(await readFile(new URL('schemas/project-connection-v1.schema.json', root), 'utf8'));
  assert.equal(handoff.properties.nextDecision.properties.manualReviewRequired.const, true);
  assert.equal(handoff.properties.claimBoundary.properties.publicSignalIsMarketValidation.const, false);
  assert.equal(handoff.properties.claimBoundary.properties.repositoryExistenceValidatesDemand.const, false);
  assert.equal(connection.properties.runtimeIntegration.const, 'NONE');
});
