import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreResults } from '../scripts/eval-code-context.mjs';

test('evaluation metrics count unique relevant paths, ranks, noise and empty results', () => {
  const rows = [{ path: 'README.md' }, { path: 'src/task.ts' }, { path: 'src/task.ts' }, { path: 'package-lock.json' }, { path: 'src/i18n/fr.ts' }];
  const result = scoreResults(rows, ['src/task.ts', 'src/other.ts']);
  assert.equal(result.recall1, 0);
  assert.equal(result.recall5, 0.5);
  assert.equal(result.mrr, 0.5);
  assert.equal(result.duplicates, 1);
  assert.equal(result.noiseShare, 0.6);
  assert.equal(result.lockShare, 0.2);
  assert.equal(result.i18nShare, 0.2);
  assert.equal(result.readmeShare, 0.2);
  assert.equal(scoreResults([], ['missing.ts']).mrr, 0);
  const code = scoreResults([{ path: 'src/clock.ts' }, { path: 'src/block.ts' }], []);
  assert.equal(code.lockShare, 0);
  assert.equal(code.noiseShare, 0);
});


test('synthetic repository evaluates search, symbols, map and dossier without project writes', { timeout: 30_000 }, async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { evaluate } = await import('../scripts/eval-code-context.mjs');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/code-context-eval/synthetic.json', import.meta.url), 'utf8'));
  assert.equal(fixture.cases.length, 8);
  const project = await mkdtemp(join(tmpdir(), 'context-eval-fixture-'));
  try {
    execFileSync('git', ['init', '--quiet', project], { timeout: 10_000, stdio: 'pipe' });
    for (const [path, text] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), text);
    }
    const first = await evaluate(project, fixture.cases);
    const second = await evaluate(project, fixture.cases);
    const { mapAcceptance } = await import('../scripts/eval-code-context.mjs');
    const acceptance = await mapAcceptance(project, ['src/task.ts', 'missing.ts']);
    assert.deepEqual(acceptance.results.map((row) => row.indexed), [true, false]);
    assert.deepEqual(first.aggregate, second.aggregate);
    for (const row of first.results) {
      assert.equal(row.metrics.recall1, 1, row.id);
      assert.equal(row.metrics.expectedHits, 1, row.id);
      if (row.action === 'symbols') assert.ok(row.response.results.some((hit) => hit.kind === 'definition' && hit.path === row.expected[0]), row.id);
      if (row.action === 'search') assert.equal(row.metrics.lockShare, 0, row.id);
    }
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual((await readdir(project)).sort(), [...new Set(['.git', ...Object.keys(fixture.files).map((path) => path.split('/')[0])])].sort());
  } finally { await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});


test('offline rescoring distinguishes references from declarations and counts mapped methods', async () => {
  const { rescoreReport } = await import('../scripts/eval-code-context.mjs');
  const report = { results: [
    { id: 'symbol', action: 'symbols', expected: ['a.ts'], response: { results: [{ path: 'a.ts', name: 'run', line: 2, kind: 'reference' }] } },
    { id: 'map', action: 'map', expected: ['a.ts'], response: { results: [{ path: 'a.ts', definitions: [{ name: 'run', line: 4, kind: 'definition' }] }] } },
  ] };
  const result = rescoreReport(report, {
    symbol: { declarations: [{ path: 'a.ts', name: 'run', line: 4 }] },
    map: { methods: [{ path: 'a.ts', name: 'run', line: 4 }, { path: 'a.ts', name: 'stop', line: 8 }] },
  });
  assert.equal(result.results[0].metrics.declarationHits, 0);
  assert.equal(result.results[1].metrics.mapMethodHits, 1);
  assert.equal(result.results[1].metrics.mapExpectedMethods, 2);
  assert.equal(result.aggregate.all.totalChars, result.results.reduce((sum, row) => sum + row.metrics.chars, 0));
});
