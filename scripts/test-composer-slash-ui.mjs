// Real app, temporary resources and stub runtime. Never touches a user Studio.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const temp = await mkdtemp(join(tmpdir(), 'prime-slash-'));
const cwd = join(temp, 'Atelier'),
  sessionDir = join(temp, 'sessions'),
  agentHome = join(temp, 'agent');
await Promise.all([cwd, sessionDir, agentHome].map((p) => mkdir(p, { recursive: true })));
const commands = [];
for (const name of ['alpha', 'beta']) {
  const path = join(cwd, '.prime', 'agent', 'skills', name, 'SKILL.md');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: ${name}\n---\nInstructions ${name}.`);
  commands.push({
    name: `skill:${name}`,
    source: 'skill',
    supported: true,
    description: `Méthode ${name}`,
    sourceInfo: { path },
  });
  await writeFile(
    join(sessionDir, `${name}.jsonl`),
    [
      { type: 'session', id: `slash-${name}`, cwd, timestamp: new Date().toISOString() },
      {
        type: 'message',
        id: `u-${name}`,
        parentId: null,
        message: { role: 'user', content: `Projet ${name}` },
      },
      {
        type: 'message',
        id: `a-${name}`,
        parentId: `u-${name}`,
        message: { role: 'assistant', content: 'Prêt pour la suite.' },
      },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
}
const starts = [],
  errors = [],
  checks = [];
const check = (name) => {
  checks.push(name);
  console.log('ok - ' + name);
};
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture', reasoning: true }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    starts.push(input);
    return { done: Promise.resolve({ status: 'completed', code: 0 }), cancel: async () => {} };
  },
  async close() {},
};
const app = createApp({
  initialCwd: cwd,
  sessionDir,
  agentHome,
  dataDir: join(temp, 'data'),
  runtime,
  commands: { list: async () => ({ commands }) },
});
await app.store.project({ cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await launchStudioBrowser();
  const context = await browser.newContext({
    viewport: { width: 1680, height: 960 },
    locale: 'fr-FR',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(
    ({ cwd }) => {
      if (localStorage.getItem('prime-studio.selection')) return;
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'slash-alpha', projectOverview: false }),
      );
      localStorage.setItem(
        'prime-studio.docking.layout',
        JSON.stringify({
          version: 3,
          enabled: true,
          root: {
            kind: 'split',
            id: 'split-1',
            dir: 'row',
            ratio: 0.5,
            first: { kind: 'group', id: 'group-1', panels: ['conversation'], active: 'conversation' },
            second: { kind: 'group', id: 'group-2', panels: ['conv:beta'], active: 'conv:beta' },
          },
        }),
      );
      localStorage.setItem(
        'prime-studio.docking.conversations',
        JSON.stringify({
          version: 1,
          activeId: 'conversation',
          entries: ['alpha', 'beta'].map((name, i) => ({
            id: i ? 'conv:beta' : 'conversation',
            kind: 'session',
            nonce: `slash-${name}`,
            sessionId: `slash-${name}`,
            projectCwd: cwd,
            execCwd: cwd,
            viewRunId: null,
            gen: null,
          })),
        }),
      );
    },
    { cwd },
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  const left = page.locator('#composer'),
    right = page.locator('[data-cvw="composer"]');
  await expect(right).toBeVisible();
  await right.fill('/skill:be');
  const popup = page.locator('#' + (await right.getAttribute('aria-controls')));
  await expect(popup.getByRole('option')).toHaveCount(1);
  const form = await right.locator('xpath=ancestor::form').boundingBox(),
    box = await popup.boundingBox();
  await page.screenshot({ path: '.local/modular-slash/slash-modular.png' });
  console.log(JSON.stringify({ form, popup: box, errors }));
  assert.ok(Math.abs(box.x - form.x) < 2, 'suggestions belong to the input panel, not primary');
  assert.ok(Math.abs(box.width - form.width) < 2);

  check('Scoped slash menu is positioned over its own composer');
  await right.press('Tab');
  await expect(right.locator('xpath=ancestor::form').locator('.composer-command-label').first()).toHaveText(
    '/skill:beta',
  );
  await expect(right).toHaveValue('');
  await left.fill('BROUILLON AUTRE PANNEAU');
  await right.fill('Avant /skill:al après');
  await right.evaluate((el) => el.setSelectionRange(15, 15));
  await right.press('ArrowLeft');
  await right.press('ArrowRight');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await right.press('Enter');
  await expect(right).toHaveValue('Avant /skill:alpha après');
  assert.equal(
    await right.evaluate((el) => el.selectionStart),
    19,
    'caret stays at inserted skill, not message end',
  );
  await expect(left).toHaveValue('BROUILLON AUTRE PANNEAU');
  assert.equal(starts.length, 0, 'completion must never send');
  check('Mid-message Enter inserts one skill, preserves suffix and other panel, sends nothing');
  await right.press('Control+End');
  await right.press('Shift+Enter');
  await right.pressSequentially('/skill:be');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await popup.getByRole('option').click();
  await expect(right).toHaveValue('Avant /skill:alpha après\n/skill:beta ');
  const draft = '/skill:beta Avant /skill:alpha après\n/skill:beta ';
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('prime-studio.drafts'))['session:slash-beta']),
    )
    .toBe(draft);
  check('Several skills can be inserted across lines by keyboard and mouse');
  await page.reload();
  await expect(right).toBeVisible();
  await right.focus();
  await expect(right).toHaveValue('Avant /skill:alpha après\n/skill:beta ');
  await expect(left).toHaveValue('BROUILLON AUTRE PANNEAU');
  check('Both independent drafts, prefix chip and inline positions survive reload');
  // Paths, URLs, code and an ordinary selected range must not open a palette.
  for (const plain of [
    'https://example.com/skill:al',
    'docs/skill:al',
    'Utilise \\/skill:al',
    'Exemple `/skill:al',
    '```js\n/skill:al',
    '~~~\n/skill:al',
  ]) {
    await right.fill(plain);
    await expect(page.locator('#' + (await right.getAttribute('aria-controls')))).toBeHidden();
  }
  check('Paths, URLs, escaped tokens and code stay plain text');
  await right.fill('Avant /skill:al après');
  await right.evaluate((el) => el.setSelectionRange(6, 15));
  await right.press('ArrowLeft');
  await expect(page.locator('#' + (await right.getAttribute('aria-controls')))).toBeHidden();
  await right.press('Control+End');
  await right.pressSequentially(' /skill:al');
  await expect(page.locator('#' + (await right.getAttribute('aria-controls')))).toBeVisible();
  await right.press('Escape');
  await expect(page.locator('#' + (await right.getAttribute('aria-controls')))).toBeHidden();
  check('Caret navigation and Escape update the popup without losing text');
  // Clear the prefix chip, then send exactly two explicit inline skills.
  await right.locator('xpath=ancestor::form').locator('.composer-command button').first().click();
  await right.fill('D’abord /skill:alpha puis /skill:beta enfin.');
  const beforeSend = starts.length;
  await right.locator('xpath=ancestor::form').locator('[data-cvw="send"]').click();
  await expect.poll(() => starts.length).toBe(beforeSend + 1);
  const sent = starts.at(-1).message;
  assert.ok(sent.startsWith('D’abord '));
  assert.ok(sent.indexOf('<skill name="alpha"') < sent.indexOf(' puis '));
  assert.ok(sent.indexOf(' puis ') < sent.indexOf('<skill name="beta"'));
  assert.ok(sent.endsWith(' enfin.'));
  await expect(left).toHaveValue('BROUILLON AUTRE PANNEAU');
  check('Stub runtime receives both expanded skills in order at the requested positions');
  // Classic mode uses the same caret-aware completion and no scoped IDs.
  await page.locator('#open-docking').click();
  await page.locator('#docking-toggle').uncheck();
  await page.locator('#docking-close-settings').click();
  await expect(left).toBeVisible();
  await left.fill('Vérifie /skill:al ensuite');
  await left.evaluate((el) => el.setSelectionRange(16, 16));
  await left.press('ArrowLeft');
  await left.press('ArrowRight');
  await expect(page.locator('#command-suggestions')).toBeVisible();
  await left.press('Tab');
  await expect(left).toHaveValue('Vérifie /skill:alpha ensuite');
  await page.screenshot({ path: '.local/modular-slash/slash-classic.png' });
  check('Classic mode keeps the same mid-message completion');
  await left.fill('/skill:al');
  await expect(page.locator('#command-suggestions')).toBeVisible();
  await left.press('Tab');
  await expect(page.locator('#composer-form .composer-command-label').first()).toHaveText('/skill:alpha');
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await left.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      rowWidth: el.parentElement.getBoundingClientRect().width,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    assert.ok(metrics.width > metrics.rowWidth * 0.35, `Skill must not collapse input at ${width}px: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.scrollHeight <= metrics.clientHeight + 1, `Empty skill input must not scroll at ${width}px`);
  }
  await page.screenshot({ path: '.local/modular-slash/skill-classic-mobile.png' });
  await page.locator('#composer-form .composer-command button').first().click();
  assert.ok((await left.boundingBox()).width > 100, 'Input stays usable after removing the skill');
  check('Primary skill chip preserves input width without spurious scrolling at desktop, laptop and mobile widths');
  assert.deepEqual(errors, []);
  await writeFile(
    '.local/modular-slash/slash-ui-proof.json',
    JSON.stringify({ passed: true, checks, errors, realModelCalls: 0 }, null, 2),
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
