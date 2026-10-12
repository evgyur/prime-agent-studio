// Isolated mobile browser regression. No provider or real session is used.
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-studio-mobile-'));
const cwd = join(temp, 'Atelier mobile');
const emptyCwd = join(temp, 'Projet vide');
const sessionDir = join(temp, 'sessions'),
  agentHome = join(temp, 'agent');
await Promise.all([mkdir(cwd), mkdir(emptyCwd), mkdir(sessionDir), mkdir(agentHome)]);
const nativeId = 'mobile-existing-session';
await writeFile(
  join(sessionDir, 'native-history.jsonl'),
  [
    { type: 'session', id: nativeId, cwd, version: 3, timestamp: new Date().toISOString() },
    {
      type: 'message',
      id: 'u0',
      parentId: null,
      message: { role: 'user', content: 'Projet depuis le téléphone' },
    },
    {
      type: 'message',
      id: 'a0',
      parentId: 'u0',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Historique mobile retrouvé.' }] },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
await writeFile(
  join(sessionDir, 'archived-history.jsonl'),
  [
    { type: 'session', id: 'mobile-archived-session', cwd, timestamp: new Date().toISOString() },
    {
      type: 'message',
      id: 'archived-u0',
      parentId: null,
      message: { role: 'user', content: 'Ancienne conversation archivée' },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

const controls = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [
      { id: 'anthropic/claude-sonnet-4-6', name: 'Claude mobile', provider: 'anthropic', reasoning: true },
      { id: 'openai-codex/gpt-5.6-luna', name: 'Luna fixture', provider: 'openai-codex', reasoning: true },
      { id: 'openai-codex/gpt-5.6-sol', name: 'Sol mobile', provider: 'openai-codex', reasoning: true },
    ],
    default: { model: 'openai-codex/gpt-5.6-luna', thinking: 'low' },
  }),
  async start(input) {
    const index = controls.length + 1;
    const id = input.sessionId || `mobile-created-${index}`;
    const file = input.sessionFile || join(sessionDir, `${id}.jsonl`);
    if (!input.sessionId)
      await writeFile(
        file,
        JSON.stringify({ type: 'session', id, cwd: input.cwd, timestamp: new Date().toISOString() }) + '\n',
      );
    const previous = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
      .findLast((entry) => entry.type === 'message');
    const userId = `mobile-user-${index}`;
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id: userId,
        parentId: previous?.id || null,
        message: { role: 'user', content: input.message },
      }) + '\n',
    );
    let finishDone,
      finished = false;
    const done = new Promise((resolveDone) => {
      finishDone = resolveDone;
    });
    const control = {
      sessionId: id,
      input,
      done,
      cancelCalls: 0,
      emit(event) {
        if (!finished) input.onEvent(event);
      },
      async finish(status = 'completed', text = 'Réponse mobile enregistrée.') {
        if (finished) return done;
        finished = true;
        if (status === 'completed')
          await appendFile(
            file,
            JSON.stringify({
              type: 'message',
              id: `mobile-answer-${index}`,
              parentId: userId,
              message: { role: 'assistant', content: [{ type: 'text', text }] },
            }) + '\n',
          );
        const result = { kind: 'done', sessionId: id, status, code: status === 'completed' ? 0 : 130 };
        input.onEvent(result);
        finishDone(result);
        return result;
      },
      async cancel() {
        control.cancelCalls++;
        return control.finish('stopped');
      },
    };
    controls.push(control);
    setTimeout(() => control.emit({ kind: 'session', sessionId: id, cwd: input.cwd }), 20);
    return control;
  },
  async close() {
    await Promise.all(controls.map((control) => control.finish('stopped')));
  },
};

const app = createApp({ runtime, agentHome, sessionDir, dataDir: join(temp, 'data'), initialCwd: cwd });
await app.store.project({ cwd: emptyCwd, name: 'Projet vide' });
await app.store.patchSession({ id: 'mobile-archived-session', archived: true });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const code = '84726195';
const salt = '6db81d2eef331b5808c40314115ac5b9';
const gateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: app.server.address().port,
  config: { readOnly: false, salt, codeHash: hashAccessCode(code, salt) },
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${gateway.address().port}`;
const checks = [];
let browser, page;
try {
  browser = await launchStudioBrowser({ channel: 'msedge', headless: true });
  page = await browser.newPage({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  expect(
    (await page.request.post(url + '/api/runs', { data: { cwd, message: 'Denied before login' } })).status(),
  ).toBe(401);
  await page.goto(url);
  await page.locator('#code').fill(code);
  await page.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(page.locator('#connection-label')).toContainText('connecté');
  const bootstrap = await (await page.request.get(url + '/api/bootstrap')).json();
  expect(bootstrap.preferences).toMatchObject({ remote: true, readOnly: false });
  await expect(page.locator('#remote-view-banner')).toContainText('contrôle complet');
  // Authoritative full-control remote contract: model settings are visible
  // and served (baseline ca92929 app.js `hidden = state.readOnly`, NOT
  // remote; lib/lan.mjs full-control GET/PATCH allowlist; isolated probe
  // evidence login303/anon401/authed200). Unauthenticated 401 above and all
  // other checks are retained unchanged.
  expect(await page.locator('#model-config-settings').evaluate((node) => node.hidden)).toBe(false);
  expect((await page.request.get(url + '/api/model-config')).status()).toBe(200);
  checks.push('Authentification mobile, contrôle distant complet et configuration modèle accessible');

  // Real phone navigation: the project row is a disclosure toggle here, so
  // expand it and pick the existing session child (selects + closes drawer),
  // then open the overview via #header-project. Drawer must be gone before
  // any overview interaction below.
  async function selectAtelierSession() {
    await page.locator('#toggle-sidebar').click();
    const row = page.locator('#project-list .project-row').filter({ hasText: 'Atelier mobile' });
    await row.click();
    const child = page
      .locator('#project-list .session-select')
      .filter({ hasText: 'Projet depuis le téléphone' });
    if (!(await child.isVisible().catch(() => false))) await row.click();
    await expect(child).toBeVisible({ timeout: 10000 });
    await child.click();
  }
  await selectAtelierSession();
  await page.locator('#header-project').click();
  expect(await page.locator('#sidebar').evaluate((n) => n.classList.contains('mobile-open'))).toBe(false);
  await expect(page.locator('#mobile-backdrop')).toBeHidden();
  await expect(page.locator('#project-overview')).toBeVisible();
  await expect(page.locator('#project-overview')).toContainText('Projet depuis le téléphone');
  await expect(page.locator('#welcome')).toBeHidden();
  await expect(page.locator('#composer')).toBeHidden();
  await page.locator('#project-session-search').fill('introuvable-mobile-xyz');
  await expect(page.locator('#project-session-list .project-session-card')).toHaveCount(0);
  await expect(page.locator('#project-session-list')).toContainText('Aucun résultat');
  await page.locator('#project-session-search').fill('');
  await expect(page.locator('#project-session-list .project-session-card')).toHaveCount(1);
  await page.locator('#project-show-archived').click();
  await expect(page.locator('#project-session-list')).toContainText('Ancienne conversation archivée');
  await expect(page.locator('#project-session-list')).not.toContainText('Projet depuis le téléphone');
  await page.locator('#project-show-recent').click();
  await expect(page.locator('#project-session-list')).toContainText('Projet depuis le téléphone');
  checks.push('Recherche et archives dans les sessions du projet');

  // Real phone navigation for the empty project: its .project-more menu
  // mints a local blank session (no run), then #header-project opens the
  // still-empty overview. Returning to Atelier reuses the session child.
  await page.locator('#toggle-sidebar').click();
  const videMore = page.locator('#project-list .project-more[aria-label*="Projet vide"]');
  await expect(videMore).toBeVisible({ timeout: 10000 });
  await videMore.click();
  await expect(page.locator('#project-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#project-menu [data-project-action="new-session"]').click();
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#welcome')).toBeVisible();
  await page.locator('#header-project').click();
  expect(await page.locator('#sidebar').evaluate((n) => n.classList.contains('mobile-open'))).toBe(false);
  await expect(page.locator('#mobile-backdrop')).toBeHidden();
  await expect(page.locator('#project-overview-title')).toHaveText('Projet vide');
  await expect(page.locator('#project-session-list')).toContainText('Votre première session');
  await expect(page.locator('#project-session-count')).toHaveText('0 session');
  await selectAtelierSession();
  await page.locator('#header-project').click();
  await expect(page.locator('#project-overview-title')).toHaveText('Atelier mobile');
  checks.push('Projet vide expliqué et bouton central de nouvelle session');
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({
    path: resolve('test-results', 'mobile-project-sessions.png'),
    animations: 'disabled',
  });
  await page.locator('#project-overview').getByText('Projet depuis le téléphone', { exact: true }).click();
  await expect(page.locator('#messages')).toContainText('Historique mobile retrouvé.');
  await expect(page.locator('#composer')).toBeVisible();
  checks.push('Sélection de projet vers la liste centrale des sessions et ouverture de l’historique');

  await page.locator('#model-picker-button').click();
  await expect(page.locator('#model-dialog')).toBeVisible();
  await expect(page.locator('#model-search')).toBeFocused();
  const pickerBox = await page.locator('#model-dialog').boundingBox();
  expect(pickerBox.width).toBeGreaterThan(350);
  expect(Math.abs(pickerBox.y + pickerBox.height - 844)).toBeLessThanOrEqual(1);
  await page.locator('#model-search').fill('gpt 5 6 sol');
  await expect(page.locator('#model-list .model-row')).toHaveCount(1);
  const mobileSol = page.locator('#model-list .model-row').filter({ hasText: 'Sol mobile' });
  await mobileSol.locator('.model-favorite').click();
  await expect(mobileSol.locator('.model-favorite')).toHaveAttribute('aria-pressed', 'true');
  await mobileSol.locator('.model-choice').click();
  await expect(page.locator('#model-dialog')).toBeHidden();
  await expect(page.locator('#model-picker-button')).toContainText('Sol mobile');
  await expect(page.locator('#model-picker-provider')).toHaveText('openai-codex');
  checks.push('Recherche, favoris et sélection de modèle dans la feuille mobile');

  await page.locator('#composer').fill('Continue cette session depuis le téléphone.');
  await page.locator('#send-button').click();
  await expect.poll(() => controls.length).toBe(1);
  expect(controls[0].input.sessionId).toBe(nativeId);
  expect(controls[0].input.sessionFile).toBe(join(sessionDir, 'native-history.jsonl'));
  expect(controls[0].input.message).toBe('Continue cette session depuis le téléphone.');
  expect(controls[0].input.model).toBe('openai-codex/gpt-5.6-sol');
  await expect(page.locator('#stop-button')).toBeVisible();
  controls[0].emit({ kind: 'message_start', role: 'assistant' });
  controls[0].emit({ kind: 'text', delta: 'Réponse mobile en direct.' });
  await expect(page.locator('#messages')).toContainText('Réponse mobile en direct.');
  await page.reload();
  await expect(page.locator('#messages')).toContainText('Réponse mobile en direct.');
  expect(controls[0].cancelCalls).toBe(0);
  await controls[0].finish('completed');
  await expect(page.locator('#stop-button')).toBeHidden();
  await expect(page.locator('#messages')).toContainText('Réponse mobile enregistrée.');
  await page.locator('#model-picker-button').click();
  await page.locator('#model-favorites-filter').click();
  await expect(page.locator('#model-list .model-row')).toHaveCount(1);
  await expect(page.locator('#model-list')).toContainText('Sol mobile');
  await page.locator('#model-dialog [data-close-dialog]').click();
  checks.push('Reprise d’une session native, streaming authentifié et reconnexion après rechargement');

  await page.locator('#header-project').click();
  await expect(page.locator('#project-overview')).toBeVisible();
  await page.locator('#project-new-session').click();
  await page.locator('#composer').fill('Crée une session mobile à interrompre.');
  await page.locator('#send-button').click();
  await expect.poll(() => controls.length).toBe(2);
  expect(controls[1].input.sessionId).toBeFalsy();
  expect(controls[1].input.cwd).toBe(cwd);
  controls[1].emit({ kind: 'message_start', role: 'assistant' });
  controls[1].emit({ kind: 'text', delta: 'Nouvelle session mobile en cours.' });
  await expect(page.locator('#messages')).toContainText('Nouvelle session mobile en cours.');
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden();
  expect(controls[1].cancelCalls).toBe(1);
  const overview = await (await page.request.get(url + '/api/overview')).json();
  expect(
    overview.projects
      .flatMap((project) => project.sessions)
      .some((session) => session.id === controls[1].sessionId),
  ).toBe(true);
  checks.push('Création et arrêt d’une session depuis le téléphone');

  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('#model-picker-button').click();
  await expect(page.locator('#model-search')).toHaveCSS('font-size', '16px');
  const landscapeDialog = await page.locator('#model-dialog').boundingBox(),
    landscapeFavorite = await page.locator('#model-list .model-favorite[aria-pressed="true"]').boundingBox();
  expect(landscapeDialog.x).toBeGreaterThanOrEqual(0);
  expect(landscapeDialog.x + landscapeDialog.width).toBeLessThanOrEqual(844);
  expect(landscapeDialog.y + landscapeDialog.height).toBeLessThanOrEqual(390);
  expect(landscapeFavorite.width).toBeGreaterThanOrEqual(44);
  expect(landscapeFavorite.height).toBeGreaterThanOrEqual(44);
  await page.locator('#model-dialog [data-close-dialog]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  checks.push('Sélecteur tactile utilisable en orientation paysage');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: resolve('test-results', 'mobile-control.png'), animations: 'disabled' });
  await writeFile(
    resolve('test-results', 'mobile-control-report.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(error);
  if (page) {
    await mkdir(resolve('test-results'), { recursive: true });
    await page
      .screenshot({ path: resolve('test-results', 'mobile-control-failure.png'), animations: 'disabled' })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  const cleanupPath = resolve(temp);
  if (
    !cleanupPath.startsWith(resolve(tmpdir()) + sep) ||
    !basename(cleanupPath).startsWith('prime-studio-mobile-')
  )
    throw new Error('Répertoire de test non reconnu : nettoyage refusé.');
  await rm(cleanupPath, { recursive: true, force: true });
}
