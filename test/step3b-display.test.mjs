import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { successRate, stoppedRuns } from '../public/performance.js';

test('success rate excludes both user and budget stops, including stopped-only runs', () => {
  const row = { completedRuns: 2, failedRuns: 1, finishedRuns: 5 };
  assert.equal(successRate(row), 2 / 3);
  assert.equal(stoppedRuns(row), 2);
  assert.equal(successRate({ completedRuns: 0, failedRuns: 0, finishedRuns: 2 }), null);
  assert.equal(successRate({ completedRuns: 0, failedRuns: 1, finishedRuns: 3 }), 0);
  assert.equal(successRate({ completedRuns: 2, failedRuns: 0, finishedRuns: 3 }), 1);
});
test('general subagent defaults keep the shared picker without role selectors', async () => {
  const source = await readFile(new URL('../public/subagent-settings.js', import.meta.url), 'utf8');
  assert.match(source, /openModelPicker\(\{/);
  assert.match(source, /defaultLabel[^]*?ui.defaut_du_moteur/);
  assert.doesNotMatch(source, /subagent-role|draft\.roles|routing\.(explore|implement|review|inherit)/);
});
