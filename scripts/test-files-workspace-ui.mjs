// Files workspace UI: mocked new /api/project-git history/commit/commit-diff/
// worktrees endpoints, real server + temp git repo for everything else.
// Never touches user repos. No build, no commit, no agent call.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { messages } from '../public/translations.js';

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'prime-files-workspace-ui-'));
const cwd = join(temp, 'Atelier');
await mkdir(cwd, { recursive: true });
await mkdir('test-results/files-workspace', { recursive: true });
const git = (...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true });
await git('init', '-q', '-b', 'main');
await git('config', 'user.name', 'Fixture');
await git('config', 'user.email', 'fixture@example.test');
await writeFile(join(cwd, 'app.js'), 'const title = "Avant";\n');
await git('add', '.');
await git('commit', '-qm', 'Initial');
await writeFile(join(cwd, 'app.js'), 'const title = "Apr\u00e8s";\n');
await writeFile(join(cwd, 'new.txt'), 'nouveau fichier\n');

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const commitsPage1 = [
  { hash: H3, shortHash: H3.slice(0, 7), subject: 'feat: third change', body: '', authorName: 'Fixture', authorEmail: 'fixture@example.test', date: '2026-10-20T10:00:00.000Z', parents: [H2], tags: ['v1.1'], branches: [] },
  { hash: H2, shortHash: H2.slice(0, 7), subject: 'fix: second change', body: '', authorName: 'Fixture', authorEmail: 'fixture@example.test', date: '2026-10-19T10:00:00.000Z', parents: [H1], tags: [], branches: ['main'] },
];
const commitsPage2 = [
  { hash: H1, shortHash: H1.slice(0, 7), subject: 'Initial', body: '', authorName: 'Fixture', authorEmail: 'fixture@example.test', date: '2026-10-18T10:00:00.000Z', parents: [], tags: [], branches: [] },
];
const appPatch = [
  'diff --git a/app.js b/app.js',
  '--- a/app.js',
  '+++ b/app.js',
  '@@ -1 +1 @@',
  '-const title = "Avant";',
  '+const title = "Apr\u00e8s";',
  ' context line',
].join('\n');

const app = createApp({
  initialCwd: cwd,
  agentHome: join(temp, 'agent'),
  sessionDir: join(temp, 'sessions'),
  dataDir: join(temp, 'data'),
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

const status = () => ({
  git: true, branch: 'main', head: H3, upstream: 'origin/main', ahead: 0, behind: 0, remote: true, dirty: true,
});
const calls = [];
let failNext = null;
let holdOldFiles = false;
let holdSuggest = false;
let holdCommit = false;
let holdA = false;
let holdB = false;
let suggestAB = false;
let suggestCalls = 0;
const hold = (ms) => new Promise((done) => setTimeout(done, ms));
const fr = (key) => messages[key].fr;
const wtFeature = join(temp, 'wt-feature');
const wtOther = join(temp, 'wt-other');
const openedFolders = [];
async function mockGit(route) {
  const request = route.request();
  const requestUrl = new URL(request.url());
  const tail = requestUrl.pathname.replace('/api/project-git', '') || '/';
  let body = {};
  try {
    body = request.postDataJSON() || {};
  } catch {
    body = {};
  }
  calls.push({ method: request.method(), route: tail, body });
  const reply = (code, payload) =>
    route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(payload) });
  if (failNext && failNext.route === tail) {
    const failure = failNext;
    failNext = null;
    return reply(failure.status, { error: failure.error });
  }
  if (request.method() === 'GET' && tail === '/') return reply(200, status());
  if (request.method() === 'GET' && tail === '/history') {
    const offset = Number(requestUrl.searchParams.get('offset') || 0);
    if (offset >= 2) return reply(200, { commits: commitsPage2, hasMore: false, ref: H3 });
    return reply(200, { commits: commitsPage1, hasMore: true, ref: H3 });
  }
  if (request.method() === 'GET' && tail === '/commit') {
    const hash = requestUrl.searchParams.get('hash');
    if (hash === H3)
      return reply(200, {
        hash: H3, subject: 'feat: third change', body: '', authorName: 'Fixture',
        date: '2026-10-20T10:00:00.000Z', parents: [H2], tags: ['v1.1'],
        files: [
          { path: 'app.js', status: 'M', additions: 2, deletions: 1 },
          { path: 'new.txt', status: 'A', additions: 1, deletions: 0 },
        ],
        stats: { files: 2, additions: 3, deletions: 1 },
      });
    if (hash === H2 || hash === H1)
      return reply(200, {
        hash, subject: hash === H2 ? 'fix: second change' : 'Initial', body: '', authorName: 'Fixture',
        date: '2026-10-19T10:00:00.000Z', parents: [], tags: [],
        files: [{ path: 'app.js', status: 'M', additions: 1, deletions: 1 }],
        stats: { files: 1, additions: 1, deletions: 1 },
      });
    return reply(404, { error: 'unknown commit' });
  }
  if (request.method() === 'GET' && tail === '/commit-diff') {
    const hash = requestUrl.searchParams.get('hash');
    const path = requestUrl.searchParams.get('path');
    if (hash === H3 && path === 'app.js') return reply(200, { path, patch: appPatch, truncated: false, binary: false });
    if (hash === H3 && path === 'new.txt')
      return reply(200, { path, patch: '+nouveau fichier', truncated: false, binary: false });
    if (path === 'app.js' || path === 'new.txt')
      return reply(200, { path, patch: appPatch, truncated: false, binary: false });
    return reply(404, { error: 'unknown file in commit' });
  }
  if (request.method() === 'GET' && tail === '/worktrees')
    return reply(200, {
      worktrees: [
        { path: cwd, branch: 'main', head: H3, bare: false, detached: false, locked: false, prunable: false, isCurrent: true, dirty: true, managed: false },
        { path: wtFeature, branch: 'feature', head: H2, bare: false, detached: false, locked: false, prunable: false, isCurrent: false, dirty: false, managed: true, id: 'wt-1' },
        { path: wtOther, branch: 'other', head: H1, bare: false, detached: false, locked: false, prunable: false, isCurrent: false, managed: false },
      ],
      currentPath: cwd,
    });
  if (request.method() === 'POST' && tail === '/suggest-message') {
    if (suggestAB) {
      suggestCalls++;
      const gate = async (open) => {
        for (let n = 0; n < 150 && open(); n++) await hold(200);
      };
      if (suggestCalls === 1) {
        await gate(() => holdA);
        return reply(200, { message: 'message A' });
      }
      await gate(() => holdB);
      return reply(200, { message: 'message B' });
    }
    if (holdSuggest) await hold(4000);
    if (!Array.isArray(body.paths) || !body.paths.length)
      return reply(400, { error: fr('git.panel_commit_paths') });
    return reply(200, { message: 'fix: met \u00e0 jour le titre depuis le diff' });
  }
  if (request.method() === 'POST' && tail === '/commit') {
    if (holdCommit) await hold(4000);
    if (!String(body.message || '').trim()) return reply(400, { error: fr('git.panel_commit_message') });
    return reply(200, { ok: true, commit: 'f'.repeat(40), summary: 'ok', status: { ...status(), dirty: false } });
  }
  if (request.method() === 'POST' && ['/fetch', '/pull', '/push'].includes(tail)) return reply(200, status());
  return reply(404, { error: 'unknown git route' });
}

let browser;
const errors = [];
async function openFilesTab({ width, language = 'fr', theme = 'dark', readOnly = false }) {
  const context = await browser.newContext({
    locale: language === 'en' ? 'en-US' : 'fr-FR',
    colorScheme: theme,
    viewport: { width, height: width < 1080 ? 844 : 960 },
    isMobile: width < 1080,
    hasTouch: width < 1080,
  });
  // No docking.layout override: the default dock applies (writing a partial
  // object trips the invalid-layout recovery toast). Narrow and wide Files
  // layouts come from the real dock UI, never CSS injection.
  await context.addInitScript(
    ({ cwd, language, theme }) => {
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd }));
      if (language) localStorage.setItem('prime-studio.language', language);
      localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme }));
    },
    { cwd, language, theme },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/project-git**', mockGit);
  // Old-root Files reads hang on demand so a mid-flight context switch can
  // prove stale responses never populate the new view (generation transition).
  await page.route('**/api/project-files/changes**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (holdOldFiles && requestUrl.searchParams.get('cwd') === cwd) await hold(4000);
    return route.fallback();
  });
  // Folder reveals are fulfilled here: assert the reference body and prove
  // no native open ever leaves the browser.
  await page.route('**/api/projects/open', (route) => {
    openedFolders.push(route.request().postDataJSON());
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  if (readOnly)
    // Wildcard: the app boots through /api/bootstrap?light=1 and a bare
    // glob would miss the query string.
    await page.route('**/api/bootstrap*', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.preferences = { ...data.preferences, readOnly: true };
      await route.fulfill({ response, json: data });
    });
  await page.goto(url);
  await expect(page.locator('#connection-label')).toHaveText(
    language === 'en' ? 'Engine connected' : 'Moteur connect\u00e9',
  );
  // Docked shell above 1080 px (real tabs + splitter); classic panel below.
  if ((await page.locator('button[data-dock-tab="files"]').count()) > 0) {
    await page.locator('button[data-dock-tab="files"]').click();
    await expect(page.locator('#dock-view-files')).toBeVisible();
  } else {
    if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
    await page.locator('#inspector-tab-files').click();
  }
  await expect(page.locator('#inspector-git-bar')).toBeVisible();
  return { context, page };
}

// Settled-state gate before every screenshot: no invalid-layout recovery
// toast, no visible loading note in the Files panel, no error box.
async function expectFilesSettled(page) {
  await expect(page.locator('#toasts')).not.toContainText('invalide');
  await expect(page.locator('#toasts')).not.toContainText('invalid');
  await expect(page.locator('#inspector-files .inspector-note:visible', { hasText: 'Chargement' })).toHaveCount(0);
  await expect(page.locator('#files-history-error:visible')).toBeHidden();
  await expect(page.locator('#files-worktrees-error:visible')).toBeHidden();
}

// Diff lines must stack vertically (increasing Y), never one wrapped blob.
async function expectStackedDiffLines(page, selector) {
  const tops = await page.locator(`${selector} > span`).evaluateAll((nodes) =>
    nodes.slice(0, 8).map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  assert.ok(tops.length >= 3, `expected diff lines, got ${tops.length}`);
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1], `diff lines stacked (${tops})`);
}

try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  // French desktop dark, narrow sidebar: history list + summary + explicit viewer.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await expect(page.locator('#files-changes')).toBeVisible();
    await expect(page.locator('#files-history')).toContainText('Historique');
    await expect(page.locator('#files-worktrees')).toContainText('Worktrees');
    await expect(page.locator('#files-all')).toContainText('Parcourir');
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await expect(page.locator('#files-history-more')).toBeVisible();
    await page.locator('#files-history-more').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(3);
    await page.locator('#files-history-search').fill('third');
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(1);
    await page.locator('#files-history-search').fill('');
    await page.locator('#files-history-tags').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(1);
    await page.locator('#files-history-tags').click();
    await page.locator('#files-history-list [data-commit-hash="3333333333333333333333333333333333333333"]').click();
    await expect(page.locator('#files-history-detail h3').first()).toContainText('feat: third change');
    await expect(page.locator('#files-history-detail')).toContainText('v1.1');
    await expect(page.locator('#files-history-detail')).toContainText('app.js');
    // Narrow: inline patch stays hidden, explicit expand opens the viewer.
    await expect(page.locator('#files-history-expand')).toBeVisible();
    await page.locator('#files-history-expand').click();
    const filesViewer = page.locator('dialog.inspector-viewer[data-inspector-instance="primary-files"]');
    await expect(filesViewer).toContainText('const title');
    await page.keyboard.press('Escape');
    await expect(filesViewer).toBeHidden();
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/history-narrow-dark-1440.png', animations: 'disabled' });
    await context.close();
  }
  // Wide panel via the real dock splitter: true inline list + detail diffs.
  {
    const { context, page } = await openFilesTab({ width: 1600, theme: 'dark' });
    const splitter = page.locator('.dock-splitter[data-dock-split]').first();
    await splitter.focus();
    for (let n = 0; n < 24; n++) {
      if (await page.locator('#inspector-files.is-wide').count()) break;
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await expect(page.locator('#inspector-files.is-wide')).toBeAttached();
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await page.locator('#files-history-list [data-commit-hash="3333333333333333333333333333333333333333"]').click();
    await expect(page.locator('#files-history-detail h3').first()).toContainText('feat: third change');
    await expect(page.locator('#files-history-detail .files-diff')).toBeVisible();
    await expect(page.locator('#files-history-detail .files-diff')).toContainText('const title');
    await expectStackedDiffLines(page, '#files-history-detail .files-diff');
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/history-wide-dark-1440.png', animations: 'disabled' });
    // Modifications wide: selection + commit form beside the inline working diff.
    await page.locator('#files-changes').click();
    await expect(page.locator('#inspector-git-commit')).toBeVisible();
    await expect(page.locator('#git-suggest-button')).toContainText('Proposer un message');
    await expect(page.locator('#inspector-files.is-wide')).toBeAttached();
    const changeRow = page.locator('.inspector-file[data-file-path="app.js"]');
    await expect(changeRow).toBeVisible();
    await changeRow.click();
    await expect(page.locator('#files-change-diff')).toBeVisible();
    await expect(page.locator('#files-change-diff-title')).toContainText('app.js');
    await expect(page.locator('#files-change-diff-patch')).toBeVisible();
    await expect(page.locator('#files-change-diff-error')).toBeHidden();
    await expectStackedDiffLines(page, '#files-change-diff-patch');
    // Existing AI suggestion still works through the mocked endpoint (no agent).
    await page.locator('#git-suggest-button').click();
    await expect(page.locator('#git-commit-message')).toHaveValue(/met \u00e0 jour le titre/);
    const suggestCall = calls.filter((call) => call.route === '/suggest-message').at(-1);
    assert.ok(suggestCall && suggestCall.body.paths.length > 0);
    // The existing suggestion service root is the only AI call: no new endpoint.
    assert.ok(!calls.some((call) => call.route.includes('suggest') && call.route !== '/suggest-message'));
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/changes-wide-dark-1440.png', animations: 'disabled' });
    await context.close();
  }
  // Worktrees tab: Files-context switch only, unmanaged note, no fake actions.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await page.locator('#files-worktrees').click();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await expect(page.locator('.files-wt-row').first()).toContainText('Actuel');
    // Supported registered root carries no unsupported warning (only the
    // genuinely unopenable foreign row does).
    await expect(page.locator('.files-wt-row').first()).not.toContainText('indisponibles');
    await expect(page.locator('.files-wt-row').nth(2)).toContainText('inspection indisponible');
    const openButtons = page.locator('.files-wt-row button', { hasText: 'Ouvrir' });
    await expect(openButtons.first()).toBeDisabled();
    // Managed worktree opens; unmanaged foreign context stays disabled.
    await expect(openButtons.nth(1)).toBeEnabled();
    await expect(openButtons.nth(2)).toBeDisabled();
    await expect(page.locator('.files-wt-row').nth(2)).toContainText('inspection indisponible');
    // Folder reveal uses the reference convention and never opens natively.
    await page.locator('.files-wt-row').nth(1).locator('button', { hasText: 'Dossier' }).click();
    await expect.poll(() => openedFolders.length).toBe(1);
    assert.deepEqual(openedFolders[0], { cwd, reference: wtFeature });
    await openButtons.nth(1).click();
    await expect(page.locator('#files-context')).toBeVisible();
    await expect(page.locator('#files-context-branch')).toContainText('feature');
    await expect(page.locator('#files-context-reset')).toBeVisible();
    await expect(page.locator('#inspector-git-bar')).toBeVisible();
    await page.locator('#files-context-reset').click();
    await expect(page.locator('#files-context-reset')).toBeHidden();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await expect(page.locator('#files-worktree-list .inspector-note:visible')).toHaveCount(0);
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/worktrees-narrow-dark-1440.png', animations: 'disabled' });
    await context.close();
  }
  // Management stands down when the pane follows another project (pinned
  // clone path): no silent global action, clear explanation instead.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await page.evaluate(() => {
      const bridge = window.__primeWorktreesUI;
      bridge.__testOwner = bridge.ownerCwd;
      bridge.ownerCwd = () => 'C:\\pinned\\other';
    });
    await page.locator('#files-worktrees').click();
    await expect(page.locator('#files-worktrees-owner-note')).toBeVisible();
    await expect(page.locator('#files-worktrees-owner-note')).toContainText('autre projet');
    await expect(page.locator('#files-worktree-new')).toBeHidden();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    const inspectButtons = page.locator('.files-wt-row button', { hasText: 'Inspecter' });
    await expect(inspectButtons.nth(1)).toBeDisabled();
    await expect(page.locator('.files-wt-row button', { hasText: 'Ouvrir' }).nth(1)).toBeEnabled();
    await expectFilesSettled(page);
    await page.evaluate(() => {
      const bridge = window.__primeWorktreesUI;
      bridge.ownerCwd = bridge.__testOwner;
      delete bridge.__testOwner;
    });
    await page.locator('#files-worktrees').click();
    await expect(page.locator('#files-worktree-new')).toBeVisible();
    await expect(page.locator('#files-worktrees-owner-note')).toBeHidden();
    await context.close();
  }
  // Clone smoke: a second Files panel mints with the stable host class and
  // follows the same wide rules through the real splitter.
  {
    const { context, page } = await openFilesTab({ width: 1600, theme: 'dark' });
    await page.locator('button[data-dock-tab="files"]').click({ button: 'right' });
    await expect(page.locator('#docking-context-menu')).toBeVisible();
    await page.locator('#docking-context-menu .dock-menu-submenu').hover();
    await expect(page.locator('#docking-add-menu')).toBeVisible();
    await page.locator('#docking-add-menu button[data-dock-add="files"]').click();
    const cloneTab = page.locator('button[data-dock-tab^="tool:"]').first();
    await expect(cloneTab).toBeVisible({ timeout: 10000 });
    await cloneTab.click();
    await expect.poll(async () => page.locator('.files-host').count(), { timeout: 10000 }).toBe(2);
    // Only the active tab has a real width: widen until the active clone
    // (second host) carries the wide rules while the parked primary does not.
    const splitter = page.locator('.dock-splitter[data-dock-split]').first();
    await splitter.focus();
    for (let n = 0; n < 24; n++) {
      if ((await page.locator('.files-host.is-wide').count()) >= 1) break;
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await expect.poll(
      async () =>
        page.locator('.files-host').evaluateAll((els) => els.map((el) => el.classList.contains('is-wide'))),
      { timeout: 10000 },
    ).toEqual([false, true]);
    const cloneDir = await page
      .locator('.files-host')
      .nth(1)
      .locator('.files-split')
      .first()
      .evaluate((el) => getComputedStyle(el).flexDirection);
    assert.equal(cloneDir, 'row');
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/clone-wide-dark-1600.png', animations: 'disabled' });
    await context.close();
  }
  // Context race: held old-root reads/suggest must not overwrite the new
  // Files context, and Git writes in flight block the switch outright.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await expect(page.locator('.git-file-check')).not.toHaveCount(0);
    // A Git write in flight blocks the switch until it lands.
    holdCommit = true;
    await page.locator('#git-commit-message').fill('race message');
    await page.locator('#git-commit-button').click();
    await page.waitForTimeout(500);
    await page.locator('#files-worktrees').click();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await page.locator('.files-wt-row').nth(1).locator('button', { hasText: 'Ouvrir' }).click();
    await expect(page.locator('#toasts')).toContainText('en cours');
    await expect(page.locator('#files-context-reset')).toBeHidden();
    holdCommit = false;
    await expect(page.locator('#toasts')).toContainText('créé');
    // Held old-root Files read + suggest: switch mid-flight, then release.
    holdOldFiles = true;
    holdSuggest = true;
    await page.locator('#files-changes').click();
    await page.locator('#refresh-files').click();
    await page.locator('#git-suggest-button').click();
    await page.waitForTimeout(500);
    await page.locator('#files-worktrees').click();
    await page.locator('.files-wt-row').nth(1).locator('button', { hasText: 'Ouvrir' }).click();
    await expect(page.locator('#files-context-branch')).toContainText('feature');
    holdOldFiles = false;
    holdSuggest = false;
    // Late old-root responses land after the switch: new view keeps the new
    // context (error note for the unknown folder), never old rows or drafts.
    await expect(page.locator('#inspector-file-list .inspector-file')).toHaveCount(0);
    await expect(page.locator('#git-commit-message')).toHaveValue('');
    await expect(page.locator('#files-context-reset')).toBeVisible();
    await expectFilesSettled(page);
    await page.locator('#files-context-reset').click();
    await expect(page.locator('#files-context-reset')).toBeHidden();
    await context.close();
  }
  // Stale AI completion: A finishes after the switch while B is pending —
  // A must release nothing; B alone writes the draft and restores the button.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    suggestAB = true;
    suggestCalls = 0;
    holdA = true;
    holdB = true;
    await page.locator('#git-suggest-button').click();
    await expect(page.locator('#git-suggest-button')).toHaveText('\u2026');
    await page.locator('#files-worktrees').click();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await page.locator('.files-wt-row').nth(1).locator('button', { hasText: 'Ouvrir' }).click();
    await expect(page.locator('#files-context-branch')).toContainText('feature');
    await page.locator('#files-context-reset').click();
    await page.locator('#files-changes').click();
    await expect(page.locator('.git-file-check')).not.toHaveCount(0);
    await page.locator('#git-suggest-button').click();
    holdA = false;
    await page.waitForTimeout(800);
    // A resolved stale mid-B: B still owns the button and the draft is empty.
    await expect(page.locator('#git-suggest-button')).toHaveText('\u2026');
    await expect(page.locator('#git-commit-message')).toHaveValue('');
    holdB = false;
    await expect(page.locator('#git-commit-message')).toHaveValue('message B');
    await expect(page.locator('#git-suggest-button')).toContainText('Proposer un message');
    suggestAB = false;
    await expectFilesSettled(page);
    await context.close();
  }
  // Actionable error + retry on a failed history call (no silent fallback).
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    failNext = { route: '/history', status: 500, error: 'boom' };
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-error')).toContainText('boom');
    await page.locator('#files-history-error button').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await context.close();
  }
  // Read-only: state visible, mutating controls hidden.
  {
    const { context, page } = await openFilesTab({ width: 1440, readOnly: true });
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await page.locator('#files-changes').click();
    await expect(page.locator('#inspector-git-commit')).toBeHidden();
    await expect(page.locator('.git-file-check')).toHaveCount(0);
    await page.locator('#files-worktrees').click();
    await expect(page.locator('#files-worktree-new')).toBeHidden();
    await context.close();
  }
  // English + light theme smoke.
  {
    const { context, page } = await openFilesTab({ width: 1440, language: 'en', theme: 'light' });
    await expect(page.locator('#files-history')).toContainText('History');
    await expect(page.locator('#files-worktrees')).toContainText('Worktrees');
    await expect(page.locator('#files-all')).toContainText('Browse');
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/files-workspace/history-narrow-light-1440.png', animations: 'disabled' });
    await context.close();
  }
  // Mobile 390: sub-tabs fit, history stays usable.
  {
    const { context, page } = await openFilesTab({ width: 390 });
    const box = await page.locator('.files-subtabs').boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= 391, JSON.stringify(box));
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/files-workspace/history-narrow-dark-390.png', animations: 'disabled' });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Files workspace UI PASS: history pagination/search/tags, inline wide diffs, viewer fallback, suggest intact, worktree Files-context, error retry, read-only, EN/light, 1440 + 390');
} finally {
  holdOldFiles = holdSuggest = holdCommit = holdA = holdB = false;
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
