// Actual Studio browser fixture. Temp homes, stub runtime and loopback only; no provider calls.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';
import { join } from 'node:path';
import { createDefaultLayout } from '../public/docking-layout.js';
const watchdog = setTimeout(() => { console.error('Step 3 UI hard timeout'); process.exit(1); }, 220000);
const models = ['swift', 'deep', 'risky'].map((name) => ({ id: `fixture/${name}`, name: name === 'swift' ? 'Swift' : name === 'deep' ? 'Deep' : 'Risky account', provider: 'fixture', reasoning: true, thinkingLevels: ['low', 'medium', 'high'], available: true }));
models.push({ id: 'fixture/offline', name: 'Offline model', provider: 'fixture', available: false, availability: 'unavailable' });
const controls = [];
const fixture = await preferencesFixture({ runtime: {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({ models, default: { model: 'fixture/swift' } }),
  start: async (input) => {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const control = { input, done, answers: [], emit: (event) => input.onEvent(event),
      cancel: async () => finish({ status: 'stopped', code: 130 }),
      respond: async (id, response) => { control.answers.push({ id, response }); return { answered: true, id }; },
      finish: (result) => { input.onEvent({ kind: 'done', ...result }); finish(result); },
    };
    controls.push(control);
    const id = input.sessionId || `step3-session-${controls.length}`;
    control.sessionId = id;
    await writeFile(join(fixture.temp, 'sessions', `${id}.jsonl`), [
      { type: 'session', id, cwd: input.cwd, timestamp: '2026-10-20T10:00:00.000Z' },
      { type: 'message', id: 'm1', message: { role: 'user', content: 'Check the local fixture only.' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    input.onEvent({ kind: 'session', sessionId: id });
    return control;
  }, close: async () => { await Promise.all(controls.map((control) => control.cancel())); },
} });
const cwd = join(fixture.temp, 'Projet de démonstration');
const browser = await launchStudioBrowser();
await mkdir('test-results/step3b', { recursive: true });
const errors = [], external = [];
async function capture(page, options) {
  await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 8000 });
  await page.screenshot(options);
}
// Per-role overrides were removed in 4.4.1: the subagent forms expose only the
// shared model and reasoning defaults. Role rows must stay absent.
async function expectNoRoles(root, label) {
  await expect(root.locator('.subagent-role-row')).toHaveCount(0);
  await expect(root.locator('[data-role-model]')).toHaveCount(0);
  await expect(root.locator('[data-role-thinking]')).toHaveCount(0);
  assert.equal(await root.locator('.subagent-roles').count(), 0, `${label}: no role section`);
}
async function noOverflow(page, panel) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await panel.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
}
try {
  for (const locale of ['fr-FR', 'en-US']) for (const width of [1440, 1100, 390]) for (const theme of width !== 1100 ? ['dark', 'light'] : ['dark']) {
    const suffix = `${locale}-${width}-${theme}`;
    if (process.argv[2] && process.argv[2] !== suffix) continue;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale, hasTouch: width === 390, reducedMotion: 'reduce' });
    await context.addInitScript(({ cwd, locale, theme, layout }) => {
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, projectOverview: false }));
      localStorage.setItem('prime-studio.language', locale.slice(0, 2));
      localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme }));
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
    }, { cwd: cwd, locale, theme, layout: { ...createDefaultLayout(), enabled: false } });
    const saves = [];
    const staleCase = process.argv[3] === 'stale';
    let confirmedAttempts = 0;
    let fallback = { revision: 'fallback-1', automatic: false, models: ['fixture/swift', 'fixture/deep'] };
    let budgets = { revision: 'budget-1', run: { tokens: 1000, estimatedCost: 1 }, projects: { [cwd]: { tokens: 10000, estimatedCost: 10 } } };
    let global = { model: '', thinking: '' };
    let project = null;
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== fixture.url) { external.push(request.url()); return route.abort(); }
      const json = (body) => route.fulfill({ json: body });
      if (url.pathname.endsWith('/quota-retry')) {
        const body = request.postDataJSON(); saves.push({ path: url.pathname, body });
        if (staleCase && body.model === 'fixture/deep' && (!body.confirmBillingChange || ++confirmedAttempts === 1))
          return route.fulfill({ status: 409, json: { code: 'quota_confirmation_required', error: 'Fixture: confirmation required' } });
        // Confirmed routing reaches a real local stub run, never a provider.
        if (['fixture/risky', ...(staleCase ? ['fixture/deep'] : [])].includes(body.model) && body.confirmBillingChange === true) {
          const response = await context.request.post(fixture.url + '/api/runs', { data: { cwd, sessionId: controls.at(-1).sessionId, message: 'Confirmed local retry fixture.', model: body.model } });
          assert.equal(response.ok(), true, await response.text());
          return route.fulfill({ json: await response.json() });
        }
        return route.fulfill({ status: 409, json: { error: 'Fixture: retry remains local' } });
      }
      if (url.pathname === '/api/quota-fallback' || url.pathname === '/api/budgets') {
        const isFallback = url.pathname.endsWith('quota-fallback');
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); saves.push({ path: url.pathname, body });
          if (isFallback) fallback = { ...body, revision: 'fallback-2' }; else budgets = { ...body, revision: 'budget-2' };
        }
        return json(isFallback ? fallback : budgets);
      }
      if (url.pathname === '/api/subagent-defaults' || url.pathname === '/api/project-subagent-defaults') {
        const isProject = url.pathname.includes('project-');
        if (request.method() === 'POST') { const body = request.postDataJSON(); saves.push({ path: url.pathname, body }); if (isProject) project = body.policy; else global = body.policy; }
        return json({ revision: 'role-1', global, project, effective: project ? { ...global, ...project } : global });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => (errors.push(error.message), console.error('PAGE ERROR', error.message)));
    await page.goto(fixture.url);
    await expect(page.locator('#connection-label')).toContainText(/connecté|connected/i);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    assert.equal((await page.request.get(fixture.url + '/public/routing-settings.js')).status(), 200, 'routing settings module is served');
    if (width === 390) await page.locator('#toggle-sidebar').click();
    await page.locator('#open-settings').click();
    await page.locator('#settings-tab-models').click();
    await page.locator('#open-model-config').click();
    const subagents = page.locator('#subagent-settings');
    await expectNoRoles(subagents, `global ${suffix}`);
    // Shared defaults still save without roles.
    await subagents.locator('#default-subagent-thinking').selectOption('medium');
    await subagents.locator('button[type="submit"]').click();
    await expect.poll(() => saves.some((s) => s.path === '/api/subagent-defaults')).toBe(true);
    assert.deepEqual(global, { model: '', thinking: 'medium' });
    assert.ok(!('roles' in global), 'global defaults carry no roles');
    await subagents.scrollIntoViewIfNeeded(); await noOverflow(page, subagents);
    if (width === 390) {
      const thinkingBounds = await subagents.locator('#default-subagent-thinking').boundingBox();
      assert.ok(thinkingBounds.width >= 220, `Mobile base reasoning needs >=220px, got ${thinkingBounds.width}`);
    }
    await capture(page, { path: `test-results/step3b/subagents-global-${suffix}.png` });
    const routing = page.locator('#engine-settings .routing-settings');
    const fallbackForm = routing.locator('[data-routing-form="fallback"]');
    await expect(fallbackForm.locator('[data-fallback-automatic]')).not.toBeChecked();
    await fallbackForm.locator('[data-model="fixture/deep"] [data-fallback-action="up"]').click();
    await expect(fallbackForm.locator('[data-model]').first()).toHaveAttribute('data-model', 'fixture/deep');
    await fallbackForm.locator('button[type="submit"]').click();
    await expect.poll(() => saves.some((s) => s.path === '/api/quota-fallback')).toBe(true);
    assert.deepEqual(fallback.models, ['fixture/deep', 'fixture/swift']); assert.equal(fallback.automatic, false);
    const budgetForm = routing.locator('[data-routing-form="budgets"]');
    await budgetForm.locator('[data-budget-scope="run"][data-budget-field="tokens"]').fill('2000');
    await budgetForm.locator('button[type="submit"]').click();
    await expect.poll(() => budgets.run.tokens).toBe(2000);
    await fallbackForm.scrollIntoViewIfNeeded(); await noOverflow(page, routing);
    await capture(page, { path: `test-results/step3b/fallback-${suffix}.png` });
    await budgetForm.scrollIntoViewIfNeeded();
    await capture(page, { path: `test-results/step3b/budgets-${suffix}.png` });
    await page.keyboard.press('Escape');
    // The project Agents panel is a separate policy scope, not a copy of globals.
    await expect(page.locator('#model-config-dialog')).not.toBeVisible();
    await page.locator('#settings-dialog [data-close-dialog]').first().click();
    await expect(page.locator('#settings-dialog')).not.toBeVisible();
    if (await page.locator('#toggle-details').getAttribute('aria-pressed') !== 'true') await page.locator('#toggle-details').click();
    await page.locator('#inspector-tab-agents').click();
    const projectSubagents = page.locator('#project-subagent-settings');
    await projectSubagents.locator('.subagent-scope').selectOption('project');
    await expectNoRoles(projectSubagents, `project ${suffix}`);
    await projectSubagents.locator('.subagent-thinking-field select').selectOption('high');
    await expect.poll(() => project).toEqual({ model: '', thinking: 'high' });
    assert.ok(!('roles' in (project || {})), 'project defaults carry no roles');
    await projectSubagents.scrollIntoViewIfNeeded();
    await capture(page, { path: `test-results/step3b/subagents-project-${suffix}.png` });
    await noOverflow(page, projectSubagents);
    await page.locator('#close-inspector').click();
    const before = controls.length;
    await page.locator('#composer').fill('Check the local fixture only.');
    await page.locator('#send-button').click();
    await expect.poll(() => controls.length).toBe(before + 1);
    const run = controls.at(-1);
    run.emit({ kind: 'budget', budget: { status: 'warning', tokens: 800, estimatedCost: .8, limits: { tokens: 1000, estimatedCost: 1 }, costKnown: true } });
    const warning = page.locator('.run-guard[data-kind="budget"]:visible');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('800');
    await noOverflow(page, warning);
    await capture(page, { path: `test-results/step3b/budget-warning-${suffix}.png` });
    await page.locator('#toggle-details').click();
    await page.locator('#inspector-tab-session').click();
    await page.locator('#detail-performance').click();
    const performance = page.locator('.performance-dialog .performance-panel');
    await expect(performance.locator('.run-guard[data-kind="budget"]')).toBeVisible();
    await expect(performance.locator('.run-guard[data-kind="budget"]')).toContainText('800');
    await noOverflow(page, performance);
    await capture(page, { path: `test-results/step3b/performance-warning-${suffix}.png` });
    await page.keyboard.press('Escape');
    await page.locator('#close-inspector').click();
    run.emit({ kind: 'budget', budget: { status: 'paused', tokens: 1000, estimatedCost: 1, limits: { tokens: 1000, estimatedCost: 1 }, costKnown: true } });
    run.emit({ kind: 'interaction', request: { id: 'budget-question', method: 'select', title: 'Budget reached', options: ['Continue +50%', 'Unlimited this run', 'Stop'], status: 'pending', allowCustom: false, createdAt: 1700000000000 } });
    await expect(page.locator('.agent-question:visible')).toBeVisible();
    await expect(page.locator('.agent-question:visible')).toContainText(locale.startsWith('fr') ? 'Arrêter' : 'Stop');
    await noOverflow(page, page.locator('.agent-question:visible'));
    await capture(page, { path: `test-results/step3b/budget-question-${suffix}.png` });
    await page.locator('.agent-question:visible input[type="radio"]').first().check();
    await page.locator('.agent-question:visible button[type="submit"]').click();
    await expect.poll(() => run.answers.length).toBe(1);
    run.emit({ kind: 'budget', budget: { status: 'ok', tokens: 1000, estimatedCost: 1, limits: { tokens: 1500, estimatedCost: 1.5 }, costKnown: true } });
    run.finish({ status: 'failed', code: 1, quota: { resetAt: '2030-06-12T12:00:00.000Z', candidates: [{ model: 'fixture/deep', reason: 'automatic_disabled', automaticEligible: false }, { model: 'fixture/risky', reason: 'identity_unknown', automaticEligible: false }, { model: 'fixture/unavailable', reason: 'unavailable', automaticEligible: false }] } });
    const quota = page.locator('.run-guard[data-kind="quota"]:visible');
    await expect(quota).toBeVisible();
    await expect(quota).toContainText('2030');
    await noOverflow(page, quota);
    await expect(quota.locator('[data-retry-model="fixture/deep"]')).toBeEnabled();
    await expect(quota.locator('[data-retry-model="fixture/deep"]')).toHaveText(locale.startsWith('fr') ? 'Relancer avec Deep' : 'Retry with Deep');
    await expect(quota.locator('[data-retry-model="fixture/deep"]')).toHaveAttribute('title', 'fixture/deep');
    await expect(quota.locator('[data-retry-model="fixture/deep"]')).toHaveAttribute('aria-label', /fixture\/deep/);
    await capture(page, { path: `test-results/step3b/quota-reset-${suffix}.png` });
    const composerModel = await page.locator('#model-picker-label').textContent();
    await quota.locator('[data-retry-model="fixture/deep"]').click();
    await expect.poll(() => saves.some((s) => s.path.endsWith('/quota-retry'))).toBe(true);
    assert.deepEqual(saves.find((s) => s.path.endsWith('/quota-retry')).body, { model: 'fixture/deep' });
    if (staleCase) {
      const modal = page.locator('dialog[data-quota-confirm]');
      const retryCount = () => saves.filter((entry) => entry.path.endsWith('/quota-retry')).length;
      const count = controls.length;
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: /Annuler|Cancel/ }).click();
      assert.equal(retryCount(), 1); assert.equal(controls.length, count);
      await quota.locator('[data-retry-model="fixture/deep"]').click();
      await expect(modal).toBeVisible();
      await modal.locator('[data-quota-confirm-accept]').click();
      await expect(page.locator('#toasts')).toContainText('Fixture: confirmation required');
      await expect(modal).not.toBeVisible();
      assert.equal(retryCount(), 3); assert.equal(controls.length, count);
      await quota.locator('[data-retry-model="fixture/deep"]').click();
      await expect(modal).toBeVisible();
      await modal.locator('[data-quota-confirm-accept]').click();
      await expect.poll(() => controls.length).toBe(count + 1);
      assert.equal(retryCount(), 5);
      assert.deepEqual(saves.filter((entry) => entry.path.endsWith('/quota-retry')).at(-1).body,
        { model: 'fixture/deep', confirmBillingChange: true });
      await expect(page.locator('#model-picker-label')).toHaveText(composerModel);
      controls.at(-1).finish({ status: 'completed', code: 0 });
      await context.close(); console.log('PASS stale quota confirmation and repeated409 no-loop'); continue;
    }

    await expect(page.locator('#model-picker-label')).toHaveText(composerModel);
    await expect(quota.locator('[data-retry-model="fixture/unavailable"]')).toBeDisabled();
    if (width === 390) {
      await expect.poll(async () => quota.locator('[data-retry-model]').evaluateAll((buttons) =>
        buttons.length === 3 && buttons.every((button) => button.getBoundingClientRect().height >= 44)),
      { message: 'mobile retry buttons settle at 44px touch targets' }).toBe(true);
    }
    const retryRequests = saves.filter((s) => s.path.endsWith('/quota-retry')).length;
    const runsBeforeConfirm = controls.length;
    await quota.locator('[data-retry-model="fixture/risky"]').click();
    const confirmation = page.locator('dialog[data-quota-confirm]');
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: /Annuler|Cancel/ })).toBeFocused();
    await expect(confirmation).toContainText('Swift');
    await expect(confirmation).toContainText('Risky account');
    await expect(confirmation.locator('p').first()).toHaveAttribute('title', 'fixture/swift → fixture/risky');
    await noOverflow(page, confirmation);
    await capture(page, { path: `test-results/step3b/billing-confirmation-${suffix}.png` });
    await confirmation.getByRole('button', { name: /Annuler|Cancel/ }).click();
    await expect(confirmation).not.toBeVisible();
    assert.equal(saves.filter((s) => s.path.endsWith('/quota-retry')).length, retryRequests);
    assert.equal(controls.length, runsBeforeConfirm);
    await quota.locator('[data-retry-model="fixture/risky"]').click();
    await confirmation.locator('[data-quota-confirm-accept]').click();
    await expect.poll(() => controls.length).toBe(runsBeforeConfirm + 1);
    assert.deepEqual(saves.filter((s) => s.path.endsWith('/quota-retry')).at(-1).body, { model: 'fixture/risky', confirmBillingChange: true });
    await expect(page.locator('#model-picker-label')).toHaveText(composerModel);
    controls.at(-1).finish({ status: 'completed', code: 0 });

    if (locale === 'en-US' && width === 1440 && theme === 'dark') {
      // Focused adoption regression: the browser receives the next run through SSE.
      // Both next-run transport and overview are local fixtures, never a provider retry.
      const nextId = '00000000-0000-4000-8000-000000000044';
      let adopted = false, overviewReads = 0, subscriptions = 0;
      const beforeAuto = controls.length;
      await page.locator('#composer').fill('Check automatic retry adoption locally.');
      await page.locator('#send-button').click();
      await expect.poll(() => controls.length).toBe(beforeAuto + 1);
      const failed = controls.at(-1), sessionId = failed.sessionId;
      const next = { id: nextId, cwd, sessionId, model: 'fixture/deep', status: 'running', startedAt: new Date().toISOString(), interactions: [] };
      await page.route(`**/api/runs/${nextId}/events?**`, async (route) => {
        subscriptions++;
        await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ seq: 1, kind: 'text', delta: 'Automatic retry stream remains visible.' }) + '\n\n' });
      });
      await page.route('**/api/overview', async (route) => {
        const response = await route.fetch(), body = await response.json();
        if (adopted) { body.runs = [...body.runs.filter((r) => r.id !== nextId), next]; overviewReads++; }
        await route.fulfill({ json: body });
      });
      const previousModel = await page.locator('#model-picker-label').textContent();
      adopted = true;
      failed.finish({ status: 'failed', code: 1, quota: { retryRunId: nextId, automaticModel: 'fixture/deep' } });
      await expect.poll(() => subscriptions).toBeGreaterThan(0);
      await expect.poll(() => overviewReads).toBeGreaterThan(0);
      await expect(page.locator('#messages')).toContainText('Automatic retry stream remains visible.');
      await expect(page.locator('#model-picker-label')).toHaveText(previousModel);
      await capture(page, { path: 'test-results/step3b/automatic-adoption-en-US-1440-dark.png' });
    }
    await context.close(); console.log(`PASS Step 3 ${suffix}`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} finally { await browser.close(); await fixture.close(); clearTimeout(watchdog); }
