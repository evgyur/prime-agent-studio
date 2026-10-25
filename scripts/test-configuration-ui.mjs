import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir } from 'node:fs/promises';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';

const fixture = await createRoadmapFixture();
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
await mkdir('test-results/configuration', { recursive: true });
try {
  for (const locale of ['fr-FR', 'en-US']) {
    const page = await browser.newPage({ locale, viewport: { width: 1440, height: 960 } });
    page.on('pageerror', (e) => errors.push(e.message));
    let providers = [],
      selected = null;
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      data.models.configuredProviders = providers;
      data.models.default.model = selected;
      await route.fulfill({ response, json: data });
    });
    await page.addInitScript((cwd) => {
      if (!localStorage.getItem('prime-studio.selection'))
        localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd }));
      // Deliberate classic-UI test: force the modular workspace off via saved
      // state (not DOM hiding) so the roadmap starts closed as asserted.
      localStorage.setItem(
        'prime-studio.docking.layout',
        JSON.stringify({
          version: 4,
          enabled: false,
          root: {
            kind: 'split',
            id: 'main',
            dir: 'row',
            ratio: 0.68,
            first: {
              kind: 'group',
              id: 'conversation-group',
              panels: ['conversation'],
              active: 'conversation',
            },
            second: {
              kind: 'group',
              id: 'tools-group',
              panels: ['roadmap', 'session', 'agents', 'files'],
              active: 'roadmap',
            },
          },
        }),
      );
    }, fixture.cwd);
    await page.goto(fixture.url);
    await expect(page.locator('#open-roadmap')).toBeEnabled();
    await page.keyboard.press('Control+n');
    // A new conversation shows the setup steps instead of the warning banner.
    const warning = page.locator('#configuration-warning');
    const gate = page.locator('#welcome .setup-gate');
    const current = gate.locator('[aria-current="step"]');
    await expect(gate).toBeVisible();
    await expect(warning).toBeHidden();
    await expect(current).toHaveAttribute('data-setup-step', 'provider');
    await expect(page.locator('#roadmap-panel')).toBeHidden();
    const doc = await fixture.app.roadmap.read(fixture.cwd);
    await expect(page.locator('#roadmap-progress')).toHaveText(`${doc.progress.percent} %`);
    await expect(page.locator('#open-roadmap')).toContainText('Roadmap');
    await page.screenshot({ path: `test-results/configuration/${locale}.png` });
    providers = ['test'];
    await page.reload();
    await expect(page.locator('#open-roadmap')).toBeEnabled();
    await page.keyboard.press('Control+n');
    await expect(current).toHaveAttribute('data-setup-step', 'main');
    await expect(warning).toBeHidden();
    selected = 'test/roadmap';
    await page.reload();
    await expect(page.locator('#open-roadmap')).toBeEnabled();
    await page.keyboard.press('Control+n');
    await expect(current).toHaveAttribute('data-setup-step', 'subagent');
    await expect(warning).toBeHidden();
    providers = [];
    await page.reload();
    await expect(current).toHaveAttribute('data-setup-step', 'provider');
    await expect(warning).toBeHidden();
    if (locale === 'fr-FR') {
      const updated = await fixture.app.roadmap.mutate(fixture.cwd, {
        action: 'step.check',
        expectedRevision: doc.revision,
        planId: doc.plans[0].id,
        stepId: doc.plans[0].steps[0].id,
        done: false,
      });
      await expect(page.locator('#roadmap-progress')).toHaveText(`${updated.progress.percent} %`, {
        timeout: 15000,
      });
    }
    await page.evaluate(
      (cwd) => localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd })),
      fixture.otherCwd,
    );
    await page.reload();
    await expect(page.locator('#open-roadmap')).toBeEnabled();
    await expect(page.locator('#roadmap-progress')).toBeHidden();
    await page.close();
  }
  expect(errors).toEqual([]);
  expect(fixture.calls).toEqual([]);
  console.log(
    'Setup steps in new conversations, native defaults, closed roadmap progress and project changes verified in French and English; no model calls.',
  );
} finally {
  await browser.close();
  await fixture.close();
}
