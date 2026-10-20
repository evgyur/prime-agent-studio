// Local fixture runtime and real seeded ledger. No provider calls.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';
import { messages } from '../public/translations.js';
for (const [key, message] of Object.entries(messages).filter(([key]) => key.startsWith('performance.'))) {
  assert.doesNotMatch(message.fr, /jetons?/i, `${key}: use tokens consistently`);
}
assert.equal(messages['performance.tokens'].fr, 'Tokens');
assert.equal(messages['performance.ttft'].fr, 'Latence du premier token');
assert.equal(messages['performance.ttft'].en, 'Median time to first token');
const temp = await mkdtemp(join(tmpdir(), 'studio-performance-'));
const cwd = join(temp, 'Atelier'), other = join(temp, 'Orbit');
const dataDir = join(temp, 'data'), sessionDir = join(temp, 'sessions');
for (const dir of [cwd, other, dataDir, sessionDir, join(temp, 'agent'), join(dataDir, 'metrics')]) await mkdir(dir, { recursive: true });
const jsonl = (rows) => rows.map(JSON.stringify).join('\n') + '\n';
const now = Date.now();
for (const [id, project, title] of [['alpha', cwd, 'Alpha conversation'], ['beta', other, 'Beta conversation']]) {
  await writeFile(join(sessionDir, `${id}.jsonl`), jsonl([
    { type: 'session', id, cwd: project, version: 3, timestamp: new Date(now).toISOString() },
    { type: 'message', id: `${id}-u`, message: { role: 'user', content: title, timestamp: now } },
    { type: 'message', id: `${id}-a`, parentId: `${id}-u`, message: { role: 'assistant', provider: 'fixture', model: 'swift', content: [{ type: 'text', text: 'Fixture response' }], timestamp: now, usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 20, cost: { total: 0.01 } } } },
  ]));
}
for (let day = 0; day < 12; day++) {
  const ts = now - day * 86400000, rows = [];
  for (const [project, model, count, cost] of [[cwd, 'swift', 4, 0.1], [cwd, 'deep', 1, 1], [other, 'orbit', 1, 0.2]]) {
    for (let n = 0; n < count; n++) {
      const base = { ts, project, provider: 'fixture', model }, id = `${day}-${model}-${n}`;
      rows.push({ ...base, id: `${id}-start`, type: 'run_start' }, { ...base, id: `${id}-end`, type: 'run_end', status: n === 3 ? 'stopped' : n === 2 ? 'failed' : 'completed', errorClass: n === 2 ? 'runtime' : null, durationMs: model === 'deep' ? 8000 : 2400, ttftMs: 320 }, { ...base, id: `${id}-usage`, type: 'message_end', usage: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 500, cost } });
    }
  }
  await writeFile(join(dataDir, 'metrics', new Date(ts).toISOString().slice(0, 10) + '.jsonl'), jsonl(rows));
}
const controls = [];
const app = createApp({ dataDir, sessionDir, agentHome: join(temp, 'agent'), initialCwd: cwd, runtime: {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({ models: [{ id: 'fixture/swift', provider: 'fixture', name: 'Swift' }], default: { model: 'fixture/swift' } }),
  async start(input) {
    let resolve; const done = new Promise((r) => { resolve = r; });
    const control = { done, finish() { const event = { kind: 'done', status: 'completed', code: 0 }; input.onEvent(event); resolve(event); }, async cancel() { this.finish(); } };
    controls.push(control); return control;
  }, async close() { for (const control of controls) control.finish(); },
} });
await app.store.project({ cwd }); await app.store.project({ cwd: other });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
const errors = [];
await mkdir('test-results/step3b/performance', { recursive: true });
async function setup(width, locale = 'en-US', docked = true) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, reducedMotion: 'reduce', isMobile: width === 390, hasTouch: width === 390 });
  await context.addInitScript(({ cwd, layout }) => {
    if (!localStorage.getItem('prime-studio.selection')) localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'alpha', projectOverview: false }));
    if (!localStorage.getItem('prime-studio.docking.layout')) localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
  }, { cwd, layout: { ...createDefaultLayout(), enabled: docked } });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, context };
}
async function addPerformance(page) {
  await page.locator('[data-dock-group]').last().locator('.dock-bar > .dock-chrome-button:not([data-dock-close])').first().click();
  await page.locator('#docking-context-menu [aria-controls="docking-add-menu"]').click();
  await page.locator('#docking-add-menu [data-dock-add="performance"]').click();
  const panel = page.locator('.performance-panel:visible');
  await expect(panel.locator('[data-state="ready"]')).toBeVisible(); return panel;
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.performance-panel:visible').evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
}
async function chartScale(panel, measure = 'cost') {
  const maximum = panel.locator('.performance-maximum'), zero = panel.locator('.performance-zero');
  await expect(maximum).toBeVisible(); await expect(zero).toHaveText('0');
  // Cost scale uses the same currency formatter as the cost figures ($US in French, $ in English).
  await expect(maximum).toHaveText(measure === 'cost' ? /^(?=.*[1-9])(?=.*\$).*$/ : /[1-9].* tokens$/);
  await expect(panel.locator('.performance-bar').first()).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2}: .+/);
  assert.equal(await maximum.evaluate((node) => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    const panel = node.closest('.performance-panel'), bounds = panel.getBoundingClientRect();
    const probe = document.createElement('span'); probe.style.color = 'var(--muted)'; panel.append(probe);
    const muted = getComputedStyle(probe).color; probe.remove();
    return style.fontVariantNumeric.includes('tabular-nums') && style.color === muted && rect.left >= bounds.left && rect.right <= bounds.right && Math.ceil(rect.width) >= node.scrollWidth; // scrollWidth is rounded to an integer
  }), true, 'scale uses muted tabular text and fits the panel');
}
async function toolbarAligned(panel) {
  const boxes = await panel.locator('.performance-toolbar select, .performance-toolbar button').evaluateAll((nodes) => nodes.map((node) => {
    const { top, bottom } = node.getBoundingClientRect(); return { top, bottom };
  }));
  assert.equal(boxes.length, 3);
  assert.ok(Math.max(...boxes.map((box) => box.top)) < Math.min(...boxes.map((box) => box.bottom)), 'toolbar controls share one row');
  assert.ok(Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.bottom)) <= 1, 'toolbar control bottoms align');
}
async function runStatusGroups(panel) {
  const groups = panel.locator('.performance-run-status');
  await expect(groups).toHaveCount(3);
  assert.equal(await groups.first().evaluate((node) => getComputedStyle(node).fontSize), '11px', 'run counts stay readable');
  await expect(groups.nth(0)).toHaveText(/^(Succeeded|Réussies) \d+$/);
  await expect(groups.nth(2)).toHaveText(/^(Stopped|Arrêtées) [1-9]\d*$/);
  const rate = panel.locator('[data-group="model"] tbody tr').filter({ hasText: 'fixture/swift' }).locator('td').nth(1);
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(Date.parse(to) - 6 * 86400000).toISOString().slice(0, 10);
  const summary = await (await panel.page().request.get(`${url}/api/metrics/summary?from=${from}&to=${to}&groupBy=model`)).json();
  const row = summary.groups.find((row) => row.key === 'fixture/swift');
  assert.ok(row.finishedRuns > row.completedRuns + row.failedRuns, 'fixture includes stopped runs');
  const expected = row.completedRuns / (row.completedRuns + row.failedRuns);
  const actual = Number((await rate.textContent()).replace(',', '.').replace(/[^0-9.]/g, ''));
  assert.ok(Math.abs(actual - expected * 100) < .06, `rate ${actual} excludes stopped runs (${expected * 100})`);
  await expect(rate).toHaveAttribute('title', /(?:Stopped|Arrêtées): [1-9]\d*/);
  for (const group of await groups.all()) {
    await expect(group).toHaveText(/\S+ \d+/);
    assert.equal(await group.evaluate((node) => {
      const range = document.createRange(); range.selectNodeContents(node);
      return range.getClientRects().length === 1 && getComputedStyle(node).whiteSpace === 'nowrap' && getComputedStyle(node.parentElement).whiteSpace === 'normal';
    }), true, 'status label and count stay on one line; groups may wrap');
  }
}
try {
  // Disclosure regression: actual timer refresh, changed data, focused summary,
  // then a session round trip. The baseline option must fail the open assertion.
  {
    const { page, context } = await setup(1440, 'en-US', false);
    if (process.argv.includes('--baseline')) await page.route('**/public/inspector.js', (route) => route.fulfill({ path: 'test-results/step3b/performance/inspector-before.js', contentType: 'text/javascript' }));
    let reads = 0;
    await page.route('**/api/inspector?**', async (route) => {
      const response = await route.fetch(), data = await response.json(); reads++;
      data.session ||= {};
      data.session.subagentCount = 1;
      data.session.usage = { input: reads, output: 10, cacheRead: 20, cacheWrite: 0, cost: 0.1 };
      data.session.totalUsage = { ...data.session.usage, input: reads + 50 };
      await route.fulfill({ json: data });
    });
    await page.goto(url);
    const detail = page.locator('#inspector-usage details'), summary = detail.locator('summary');
    await expect(summary).toBeVisible(); await summary.focus(); await page.keyboard.press('Enter');
    await expect(detail).toHaveAttribute('open', '');
    const before = reads;
    const scroll = await page.locator('#inspector-session').evaluate((node) => node.scrollTop);
    await expect.poll(() => reads, { timeout: 8000 }).toBeGreaterThan(before);
    await page.waitForTimeout(150);
    await expect(detail).toHaveAttribute('open', ''); await expect(summary).toBeFocused();
    assert.equal(await page.locator('#inspector-session').evaluate((node) => node.scrollTop), scroll);
    await page.locator('#session-list .session-select').filter({ hasText: 'Beta conversation' }).click();
    await expect(page.locator('#inspector-usage')).toBeVisible();
    await page.locator('#session-list .session-select').filter({ hasText: 'Alpha conversation' }).click();
    await expect(detail).toHaveAttribute('open', '');
    await summary.focus(); await page.keyboard.press('Enter'); await expect(detail).not.toHaveAttribute('open', '');
    console.log('PASS disclosure refresh, focus, scroll, session round trip and keyboard');
    await context.close();
  }
  if (!process.argv.includes('--disclosure-only')) {
    for (const width of [1440, 1100]) for (const locale of ['en-US', 'fr-FR']) {
      const { page, context } = await setup(width, locale);
      let reads = [];
      page.on('request', (request) => { if (request.url().includes('/api/metrics/summary')) reads.push(new URL(request.url())); });
      await page.goto(url); const panel = await addPerformance(page);
      await expect(panel.locator('.performance-subtitle')).toHaveText('Atelier');
      const projectId = reads.at(-1).searchParams.get('project'); assert.match(projectId, /^[a-f0-9]{64}$/);
      const count = reads.length; await page.waitForTimeout(5500); assert.equal(reads.length, count, 'no metrics polling');
      for (const days of ['1', '30', '90', '7']) {
        await panel.locator('[data-control="period"]').selectOption(days);
        await expect(panel.locator('[data-state="ready"]')).toBeVisible();
        const query = reads.at(-1).searchParams;
        assert.equal((Date.parse(query.get('to')) - Date.parse(query.get('from'))) / 86400000, Number(days) - 1);
      }
      await expect(panel.locator('[data-group="model"] tbody th').first()).toHaveText('fixture/deep');
      await panel.locator('[data-control="sort"]').selectOption('runs');
      await expect(panel.locator('[data-group="model"] tbody th').first()).toHaveText('fixture/swift');
      await page.locator('#session-list .session-select').filter({ hasText: 'Beta conversation' }).click();
      await expect(panel.locator('.performance-subtitle')).toHaveText('Orbit');
      await expect(panel.locator('[data-state="ready"]')).toBeVisible();
      assert.notEqual(reads.at(-1).searchParams.get('project'), projectId);
      const tab = page.locator('[data-dock-tab="performance"], [data-dock-tab^="tool:performance:"]');
      const id = await tab.getAttribute('data-dock-tab');
      await page.locator(`[data-dock-lock="${id}"]`).click();
      await page.locator('#session-list .session-select').filter({ hasText: 'Alpha conversation' }).click();
      await expect(panel.locator('.performance-subtitle')).toHaveText('Orbit');
      await panel.locator('[data-control="scope"]').selectOption('all');
      await expect(panel.locator('[data-group="project"] tbody th')).toHaveText(['Atelier', 'Orbit']);
      assert.equal(reads.at(-1).searchParams.has('project'), false);
      await noOverflow(page);
      await chartScale(panel);
      await runStatusGroups(panel);
      if (locale === 'fr-FR') {
        await expect(panel.locator('.performance-kpis dt')).toContainText(['Coût estimé', 'Tokens', 'Taux de cache', 'Exécutions démarrées', 'Durée médiane', 'Latence du premier token']);
        await expect(panel.locator('.performance-kpis')).not.toContainText(/jeton/i);
      }
      await page.screenshot({ path: `test-results/step3b/performance/docked-${width}-${locale}.png`, fullPage: true });
      if (width === 1440 && locale === 'en-US') {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        await page.route('**/api/metrics/summary?**', async (route) => { await gate; await route.continue(); });
        await panel.locator('[data-action="refresh"]').click();
        await expect(panel.locator('[data-state="loading"]')).toBeVisible();
        await page.screenshot({ path: 'test-results/step3b/performance/state-loading.png', fullPage: true });
        release(); await expect(panel.locator('[data-state="ready"]')).toBeVisible();
        await page.unroute('**/api/metrics/summary?**');
        await panel.locator('[data-control="chart"]').selectOption('tokens');
        await expect(panel.locator('.performance-chart')).toHaveAttribute('aria-label', /Tokens/);
        await chartScale(panel, 'tokens');
        const composer = page.locator('textarea:visible').first();
        await composer.fill('Fixture run for metrics'); await composer.press('Enter');
        await expect.poll(() => controls.length).toBeGreaterThan(0);
        const beforeDone = reads.length;
        controls.at(-1).finish();
        await expect.poll(() => reads.length).toBeGreaterThan(beforeDone);
        await expect(panel.locator('[data-state="ready"]')).toBeVisible();
        const afterDone = reads.length; await page.waitForTimeout(2500);
        assert.equal(reads.length, afterDone, 'completion refresh is debounced, not periodic');
        await page.locator('[data-dock-tab="session"]').click();
        const hiddenReads = reads.length;
        await composer.fill('Hidden fixture run'); await composer.press('Enter');
        await expect.poll(() => controls.length).toBe(2); controls.at(-1).finish();
        await page.waitForTimeout(2500); assert.equal(reads.length, hiddenReads, 'hidden panel does not refresh on completion');
        await tab.click(); await expect(panel.locator('[data-state="ready"]')).toBeVisible();
        assert.ok(reads.length > hiddenReads, 'revealing the panel refreshes');
        await page.reload();
        await expect(page.locator('.performance-panel:visible .performance-subtitle')).toHaveText('Orbit');
        await expect(page.locator('.performance-panel:visible [data-state="ready"]')).toBeVisible();
        await panel.locator('[data-control="scope"]').selectOption('all');
        await expect(panel.locator('[data-state="ready"]')).toBeVisible();
        await page.evaluate(async () => { const { setLanguage } = await import('/public/i18n.js'); setLanguage('fr'); });
        await expect(panel.locator('[data-control="scope"] option:checked')).toHaveText('Tous les projets');
        await page.evaluate(() => {
          const prefs = JSON.parse(localStorage.getItem('prime-studio.preferences') || '{}');
          localStorage.setItem('prime-studio.preferences', JSON.stringify({ ...prefs, theme: 'light' }));
        });
        await page.reload();
        await expect(panel.locator('[data-state="ready"]')).toBeVisible();
        await panel.locator('[data-control="scope"]').selectOption('all');
        await expect(panel.locator('[data-state="ready"]')).toBeVisible();
        await chartScale(panel);
        await page.screenshot({ path: 'test-results/step3b/performance/docked-light.png', fullPage: true });
        await panel.locator('[data-group="model"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: 'test-results/step3b/performance/model-ranking.png', fullPage: true });
        // Error and partial states use the same real ledger with transport/metadata faults.
        for (const state of ['error', 'empty', 'no-daily', 'backfilling', 'incomplete', 'truncated', 'unknown', 'stopped-only']) {
          await page.route('**/api/metrics/summary?**', async (route) => {
            if (state === 'error') return route.fulfill({ status: 503, json: { error: 'fixture failure' } });
            const response = await route.fetch(), value = await response.json();
            if (state === 'empty') {
              // Get a real empty aggregate, not populated totals with missing groups.
              const emptyUrl = new URL(route.request().url());
              emptyUrl.searchParams.set('project', '0'.repeat(64));
              return route.fulfill({ json: await (await route.fetch({ url: emptyUrl.href })).json() });
            } else if (state === 'no-daily') {
              if (new URL(route.request().url()).searchParams.get('groupBy') === 'day') value.groups = [];
            }
            else if (state === 'stopped-only') {
              for (const row of [value.totals, ...value.groups]) Object.assign(row, { runs: 3, finishedRuns: 3, completedRuns: 0, failedRuns: 0 });
            }
            else if (state === 'unknown') { value.totals.costKnown = false; value.totals.unknownCostMessages = 2; value.totals.duration.medianMs = value.totals.timeToFirstToken.medianMs = null; }
            else { value.complete = false; if (state !== 'incomplete') value[state] = true; }
            return route.fulfill({ json: value });
          });
          await panel.locator('[data-action="refresh"]').click();
          await expect(panel.locator(`[data-state="${['unknown', 'no-daily', 'stopped-only'].includes(state) ? 'ready' : state}"]`)).toBeVisible();
          if (state === 'empty') {
            await expect(panel.locator('.performance-status')).toContainText('Aucune mesure');
            await expect(panel.locator('.performance-body')).toBeEmpty();
          }
          if (state === 'no-daily') {
            await expect(panel.locator('.performance-status')).not.toContainText('Aucune mesure');
            await expect(panel.locator('.performance-kpis dd').first()).not.toHaveText(/^[0\s,.]+\s*\$US$/);
            await expect(panel.locator('.performance-kpis dd').nth(1)).toHaveText(/[1-9]/);
            await expect(panel.locator('.performance-chart-note')).toHaveText(messages['performance.noDaily'].fr);
            await expect(panel.locator('.performance-chart')).toHaveCount(0);
            await expect(panel.locator('[data-group="model"] tbody tr')).not.toHaveCount(0);
          }
          if (state === 'stopped-only') {
            await expect(panel.locator('.performance-run-status').nth(2)).toHaveText('Arrêtées 3');
            await expect(panel.locator('[data-group="model"] tbody tr').first().locator('td').nth(1)).toHaveText('Non disponible');
          }
          if (state === 'unknown') { await expect(panel.locator('.performance-kpis')).toContainText('Inconnu'); await expect(panel.locator('.performance-kpis')).toContainText('Non disponible'); }
          await page.screenshot({ path: `test-results/step3b/performance/state-${state}.png`, fullPage: true });
          await page.unroute('**/api/metrics/summary?**');
        }
        await panel.locator('[data-action="refresh"]').click(); await expect(panel.locator('[data-state="ready"]')).toBeVisible();
      }
      await context.close(); console.log(`PASS docked ${width} ${locale}`);
    }
    for (const [width, locale, theme] of [[1440, 'en-US', 'dark'], [390, 'en-US', 'dark'], [390, 'en-US', 'light'], [390, 'fr-FR', 'dark'], [390, 'fr-FR', 'light']]) {
      const { page, context } = await setup(width, locale, false);
      await context.addInitScript((theme) => localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme })), theme);
      await page.goto(url);
      if (width === 390) await page.locator('#toggle-details').click();
      await page.locator('#detail-performance').click();
      const panel = page.locator('.performance-dialog .performance-panel');
      await expect(panel.locator('[data-state="ready"]')).toBeVisible();
      await noOverflow(page);
      await runStatusGroups(panel);
      await toolbarAligned(panel);
      await chartScale(panel);
      const suffix = locale === 'en-US' && theme === 'dark' ? width : `${width}-${locale}-${theme}`;
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.screenshot({ path: `test-results/step3b/performance/classic-${suffix}.png`, fullPage: true });
      await page.keyboard.press('Escape'); await expect(page.locator('.performance-dialog')).not.toBeVisible();
      await expect(page.locator('#detail-performance')).toBeFocused();
      await context.close(); console.log(`PASS classic ${width} ${locale} ${theme}`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS Performance panel');
} finally { await browser.close(); await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
