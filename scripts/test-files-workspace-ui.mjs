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
let commitDiffCalls = 0;
let fileDiffCalls = 0;
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
  if (request.method() === 'GET' && tail === '/commit-diff') commitDiffCalls++;
  const reply = (code, payload) =>
    route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(payload) });
  if (failNext && failNext.route === tail) {
    const failure = failNext;
    failNext = null;
    return reply(failure.status, { error: failure.error });
  }
  if (request.method() === 'GET' && tail === '/')
    return reply(200, { ...status(), branch: requestUrl.searchParams.get('cwd') === wtFeature ? 'feature' : 'main' });
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
          { path: 'removed.txt', status: 'D', additions: 0, deletions: 3 },
        ],
        stats: { files: 3, additions: 3, deletions: 4 },
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

// Scoped-clone tolerant selectors (primary instance bare IDs, clones --files).
const commitBox = (page) => page.locator('#inspector-git-commit');
const commitMessage = (page) => page.locator('#git-commit-message');
const suggestButton = (page) => page.locator('#git-suggest-button');
const commitButton = (page) => page.locator('#git-commit-button');
const filesViewer = (page) =>
  page.locator('dialog.inspector-viewer[data-inspector-instance="primary-files"]').first();

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
  // Count working-tree diff fetches: none may fire before the user opens the
  // viewer (row click). Polling and tab switches must stay diff-free.
  await page.route('**/api/project-files/diff**', async (route) => {
    fileDiffCalls++;
    return route.fallback();
  });
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
    language === 'en' ? 'Engine connected' : 'Moteur connecté',
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
// toast, no visible loading note in the Files panel (periodic polling must not
// flash "Chargement"/"Loading"), no error box.
async function expectFilesSettled(page) {
  await expect(page.locator('#toasts')).not.toContainText('invalide');
  await expect(page.locator('#toasts')).not.toContainText('invalid');
  await expect(page.locator('#inspector-files .inspector-note:visible', { hasText: 'Chargement' })).toHaveCount(0);
  await expect(page.locator('#inspector-files .inspector-note:visible', { hasText: 'Loading' })).toHaveCount(0);
  await expect(page.locator('#files-history-error:visible')).toBeHidden();
  await expect(page.locator('#files-worktrees-error:visible')).toBeHidden();
}

function resetDiffCounters() {
  commitDiffCalls = 0;
  fileDiffCalls = 0;
}

// Diff additions/removals must be visibly green/red in the viewer, never a
// single wrapped blob: stacked spans with distinct add/remove colors.
async function expectViewerDiffColors(page, viewer) {
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.diff-add').first()).toBeVisible({ timeout: 15000 });
  await expect(viewer.locator('.diff-remove').first()).toBeVisible({ timeout: 15000 });
  const tops = await viewer.locator('pre > span').evaluateAll((nodes) =>
    nodes.slice(0, 8).map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  assert.ok(tops.length >= 3, `expected diff lines, got ${tops.length}`);
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1], `diff lines stacked (${tops})`);
  const colors = await viewer.locator('.diff-add, .diff-remove').evaluateAll((nodes) =>
    nodes.slice(0, 6).map((node) => {
      const style = getComputedStyle(node);
      return { cls: node.className, color: style.color, background: style.backgroundColor };
    }),
  );
  assert.ok(colors.length >= 2, JSON.stringify(colors));
  const parse = (rgb) => (rgb.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  for (const entry of colors) {
    const [r, g, b] = parse(entry.color);
    if (entry.cls.includes('diff-add')) assert.ok(g > r && g >= b, `add should read green: ${JSON.stringify(entry)}`);
    else assert.ok(r > g && r >= b, `remove should read red: ${JSON.stringify(entry)}`);
  }
}

async function expectToolbarRow(page) {
  await expect(page.locator('#git-fetch-button')).toHaveText('Fetch');
  const geometry = await page.locator('#git-branch-button, #git-sync-counts, #git-fetch-button, #git-pull-button, #git-push-button').evaluateAll((nodes) => nodes.map((node) => {
    const r = node.getBoundingClientRect(); return { y: r.y + r.height / 2, right: r.right };
  }));
  assert.ok(Math.max(...geometry.map(r => r.y)) - Math.min(...geometry.map(r => r.y)) < 3, JSON.stringify(geometry));
  assert.ok(Math.max(...geometry.map(r => r.right)) <= page.viewportSize().width, JSON.stringify(geometry));
}

try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  // French desktop dark: Changes is a file list only — row click opens viewer.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await expect(page.locator('#files-changes')).toBeVisible();
    await expect(page.locator('#files-history')).toContainText('Historique');
    await expect(page.locator('#files-worktrees')).toContainText('Worktrees');
    await expect(page.locator('#files-all')).toContainText('Parcourir');
    // No duplicate context banner; selected context reads from #git-branch-label.
    await expect(page.locator('#files-context')).toHaveCount(0);
    await expect(page.locator('#files-context-switch')).toHaveCount(0);
    await expect(page.locator('#files-context-branch')).toHaveCount(0);
    // No inline diff elements anywhere in the Changes pane.
    await expect(page.locator('#files-change-diff')).toHaveCount(0);
    await expect(page.locator('#files-change-diff-title')).toHaveCount(0);
    await expect(page.locator('#files-change-diff-patch')).toHaveCount(0);
    await expect(page.locator('#files-change-diff-open')).toHaveCount(0);
    // Checkbox selection is retained; file list shows both dirty files.
    await expect(page.locator('.git-file-check')).toHaveCount(2);
    await expect(page.locator('.git-file-check[data-git-path="app.js"]')).toBeChecked();
    resetDiffCounters();
    // Clicking a row opens the existing file viewer directly (no inline diff).
    await page.locator('.inspector-file[data-file-path="app.js"]').click();
    const viewer = filesViewer(page);
    await expect(viewer).toContainText('const title', { timeout: 15000 });
    await expectViewerDiffColors(page, viewer);
    // No background diff fetch fired before the explicit open; the single open
    // fetched exactly the viewer payload.
    assert.ok(fileDiffCalls >= 1, `viewer open should fetch diff once, got ${fileDiffCalls}`);
    await expect(commitDiffCalls).toEqual(0);
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    // Checkbox selection survives a polling refresh with no loading flash.
    // Silent loadFiles keeps the row nodes (identical list markup).
    await page.locator('.git-file-check[data-git-path="new.txt"]').uncheck();
    const listHTML = await page.locator('#inspector-file-list').innerHTML();
    resetDiffCounters();
    await page.locator('#refresh-files').click();
    await expect(page.locator('.git-file-check[data-git-path="app.js"]')).toBeChecked();
    await expect(page.locator('.git-file-check[data-git-path="new.txt"]')).not.toBeChecked();
    assert.equal(await page.locator('#inspector-file-list').innerHTML(), listHTML);
    await expectFilesSettled(page);
    assert.equal(fileDiffCalls, 0);
    assert.equal(commitDiffCalls, 0);
    // The inline editor remains visible; suggestion is disabled without files.
    await page.locator('.git-file-check[data-git-path="app.js"]').uncheck();
    await expect(suggestButton(page)).toBeDisabled();
    await page.locator('.git-file-check[data-git-path="app.js"]').check();
    await page.locator('.git-file-check[data-git-path="new.txt"]').check();
    await expect(suggestButton(page)).toBeEnabled();
    await expect(commitMessage(page)).toBeVisible();
    await expect(suggestButton(page)).toHaveText('Proposer un message');
    await expectToolbarRow(page);
    await page.screenshot({ path: 'test-results/files-workspace/changes-wide-dark-1440.png', animations: 'disabled' });
    await page.locator('#inspector-files').screenshot({ path: 'test-results/files-workspace/changes-refined.png' });
    await context.close();
  }
  // History: scroll pagination/search/tags, left commits / right files, file opens viewer.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await expect(page.locator('#files-history-more')).toHaveCount(0);
    await page.locator('#files-history-list').dispatchEvent('scroll');
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(3);
    await page.locator('#files-history-search').fill('third');
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(1);
    await page.locator('#files-history-search').fill('');
    await page.locator('#files-history-tags').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(1);
    await page.locator('#files-history-tags').click();
    // Select a commit: right pane lists commit files, no inline patch.
    resetDiffCounters();
    await page.locator('#files-history-list [data-commit-hash="3333333333333333333333333333333333333333"]').click();
    await expect(page.locator('#files-history-detail h3')).toHaveText('Fichiers modifiés');
    await expect(page.locator('#files-history-list [aria-current=true]')).toContainText('v1.1');
    await expect(page.locator('#files-history-detail')).toContainText('app.js');
    await expect(page.locator('#files-history-detail .files-commit-files button')).toHaveCount(3);
    const selectedStyle = await page.locator('#files-history-list [aria-current="true"]').evaluate((el) => ({ shadow: getComputedStyle(el).boxShadow, left: getComputedStyle(el).borderLeftWidth }));
    assert.deepEqual(selectedStyle, { shadow: 'none', left: '0px' });
    const statusSymbols = await page.locator('#files-history-detail .git-file-status').allTextContents();
    assert.deepEqual(statusSymbols, ['•', '+', '−']);
    await expect(page.locator('#files-history-detail .git-additions').first()).toHaveCSS('color', 'rgb(40, 167, 69)');
    await expect(page.locator('#files-history-detail .git-deletions').first()).toHaveCSS('color', 'rgb(215, 58, 73)');
    await expect(page.locator('#files-history-detail .is-modified')).toHaveCSS('color', 'rgb(219, 171, 9)');
    // Removed controls: no per-row open/expand buttons, no inline diff.
    await expect(page.locator('#files-history-open')).toHaveCount(0);
    await expect(page.locator('#files-history-expand')).toHaveCount(0);
    await expect(page.locator('#files-history-detail .files-diff')).toHaveCount(0);
    await expect(page.locator('#files-history-detail pre')).toHaveCount(0);
    // No commit-diff HTTP fired by selection alone (files come from /commit).
    assert.equal(commitDiffCalls, 0);
    // Left commits / right files stay side-by-side on wide layout.
    const listBox = await page.locator('#files-history-list').boundingBox();
    const detailBox = await page.locator('#files-history-detail').boundingBox();
    assert.ok(listBox && detailBox, JSON.stringify({ listBox, detailBox }));
    assert.ok(detailBox.x > listBox.x, `history should be left/right, got ${JSON.stringify({ listBox, detailBox })}`);
    // Clicking a commit file opens the viewer directly with green/red diff.
    await page.locator('#files-history-detail .files-commit-files button', { hasText: 'app.js' }).first().click();
    const viewer = filesViewer(page);
    await expect(viewer).toContainText('const title', { timeout: 15000 });
    await expectViewerDiffColors(page, viewer);
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/history-narrow-dark-1440.png', animations: 'disabled' });
    await context.close();
  }
  // A real scrollable page: wheel at the bottom loads one page, retains scroll, stops at EOF.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    const offsets = [];
    const page1 = [commitsPage1[0], ...Array.from({ length: 49 }, (_, i) => ({
      ...commitsPage1[1], hash: (i + 100).toString(16).padStart(40, '0'), subject: `Commit ${i + 1}`,
    }))];
    await page.route('**/api/project-git/history*', async (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0);
      offsets.push(offset);
      await route.fulfill({ json: { commits: offset ? commitsPage2 : page1, hasMore: offset === 0, ref: H3 } });
    });
    await page.locator('#files-history').click();
    const list = page.locator('#files-history-list');
    await expect(list.locator('[data-commit-hash]')).toHaveCount(50);
    await list.hover();
    await page.mouse.wheel(0, 4000);
    await expect(list.locator('[data-commit-hash]')).toHaveCount(51);
    assert.deepEqual(offsets, [0, 50]);
    assert.ok(await list.evaluate(el => el.scrollTop > 0));
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(150);
    assert.deepEqual(offsets, [0, 50], 'no duplicate or EOF requests');
    await context.close();
  }
  // Wide viewport: history columns stay left/right by rects (always CSS grid now).
  {
    const { context, page } = await openFilesTab({ width: 1600, theme: 'dark' });
    const splitter = page.locator('.dock-splitter[aria-orientation="vertical"]').first();
    await splitter.focus();
    for (let i = 0; i < 10; i++) await splitter.press('Shift+ArrowLeft');
    await expect.poll(async () => (await page.locator('#inspector-files').boundingBox()).width).toBeGreaterThan(700);
    await expect(page.locator('#inspector-files.is-wide')).toHaveCount(0);
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await page.locator('#files-history-list [data-commit-hash="3333333333333333333333333333333333333333"]').click();
    await expect(page.locator('#files-history-detail .files-commit-files button')).toHaveCount(3);
    await expect(page.locator('#files-history-detail .files-diff')).toHaveCount(0);
    const listBox = await page.locator('#files-history-list').boundingBox();
    const detailBox = await page.locator('#files-history-detail').boundingBox();
    assert.ok(listBox && detailBox, JSON.stringify({ listBox, detailBox }));
    assert.ok(detailBox.x > listBox.x, `history should be left/right, got ${JSON.stringify({ listBox, detailBox })}`);
    assert.ok(
      detailBox.y < listBox.y + listBox.height && listBox.y < detailBox.y + detailBox.height,
      `columns should overlap vertically, got ${JSON.stringify({ listBox, detailBox })}`,
    );
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/history-wide-dark-1600.png', animations: 'disabled' });
    await page.locator('#inspector-files').screenshot({ path: 'test-results/files-workspace/history-refined.png' });
    await context.close();
  }
  // Visible commit editor: suggest, retain draft and commit only selected paths.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await expect(commitMessage(page)).toBeVisible();
    await expect(page.locator('#git-commit-dialog')).toHaveCount(0);
    await suggestButton(page).click();
    await expect(commitMessage(page)).toHaveValue(/met à jour le titre/);
    await commitMessage(page).fill('Corrige le titre');
    await page.locator('.git-file-check[data-git-path="new.txt"]').uncheck();
    await page.screenshot({ path: 'test-results/files-workspace/commit-inline-dark-1440.png', animations: 'disabled' });
    const before = calls.filter((call) => call.route === '/commit').length;
    await commitButton(page).click();
    await expect.poll(() => calls.filter((call) => call.route === '/commit').length).toBeGreaterThan(before);
    const commitCall = calls.filter((call) => call.route === '/commit').at(-1);
    assert.deepEqual(commitCall.body.paths, ['app.js']);
    assert.equal(commitCall.body.message, 'Corrige le titre');
    await expect(commitMessage(page)).toHaveValue('');
    await expectFilesSettled(page);
    await context.close();
  }
  // Worktrees tab: label carries (N) only when N > 1; context via Git bar.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await page.locator('#files-worktrees').click();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await expect(page.locator('#files-worktrees')).toContainText(/Worktrees\s*\(3\)/);
    await expect(page.locator('.files-wt-current')).toHaveCount(1);
    const currentRow = page.locator('.files-wt-row.is-current');
    await expect(currentRow).toHaveCSS('border-top-left-radius', '8px');
    await expect(currentRow.locator('.files-wt-current')).toHaveText('Actuel');
    await expect(currentRow.locator('.files-wt-path')).toHaveText(cwd);
    await expect(currentRow.locator('.files-wt-state')).toHaveText('Modifications en cours');
    await expect(page.locator('.files-wt-row').nth(1).locator('.files-wt-state')).toHaveText('Propre');
    const pathBox = await currentRow.locator('.files-wt-path').boundingBox();
    const statusBox = await currentRow.locator('.files-wt-status').boundingBox();
    assert.ok(statusBox.y >= pathBox.y + pathBox.height, 'state must be below the path');
    assert.ok(await currentRow.locator('.files-wt-path').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
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
    // New contract: no duplicate #files-context banner; the Git bar shows it.
    await expect(page.locator('#files-context')).toHaveCount(0);
    await expect(page.locator('#git-branch-label')).toContainText('feature');
    await expect(page.locator('.files-wt-current')).toHaveCount(1);
    await expect(page.locator('.files-wt-row').nth(1).locator('.files-wt-current')).toHaveText('Actuel');
    await expect(page.locator('.files-wt-row').first().locator('.files-wt-current')).toHaveCount(0);
    await expect(page.locator('#inspector-git-bar')).toBeVisible();
    const resetInBar = page.locator('#inspector-git-bar #files-context-reset');
    await expect(resetInBar).toBeVisible();
    await resetInBar.click();
    await expect(page.locator('#git-branch-label')).toContainText('main');
    await expect(resetInBar).toBeHidden();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await expect(page.locator('#files-worktree-list .inspector-note:visible')).toHaveCount(0);
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/worktrees-narrow-dark-1440.png', animations: 'disabled' });
    await page.locator('#inspector-files').screenshot({ path: 'test-results/files-workspace/worktrees-refined.png' });
    await context.close();
  }
  // Single worktree: the tab carries no counter.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await page.route('**/api/project-git/worktrees*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          worktrees: [
            { path: cwd, branch: 'main', head: 'a'.repeat(40), dirty: false, managed: false, isCurrent: true },
          ],
          currentPath: cwd,
        }),
      }),
    );
    await page.locator('#files-worktrees').click();
    await expect(page.locator('.files-wt-row')).toHaveCount(1);
    await expect(page.locator('#files-worktrees')).toHaveText('Worktrees');
    await expectFilesSettled(page);
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
    // The clone is a functional Files panel: its History tab lists commits and
    // its columns sit left/right by rects (no .is-wide class anymore).
    const cloneHost = page.locator('.files-host').nth(1);
    await expect(cloneHost.locator('.files-subtabs')).toBeVisible();
    await cloneHost.locator('[data-panel-id="files-history"]').click();
    await expect(cloneHost.locator('[data-commit-hash]').first()).toBeVisible({ timeout: 15000 });
    await expect(cloneHost.locator('.files-commit-files button')).toHaveCount(3);
    const cloneList = await cloneHost.locator('.files-list-col, #files-history-list').first().boundingBox();
    const cloneDetail = await cloneHost.locator('.files-detail-col, #files-history-detail').first().boundingBox();
    assert.ok(cloneList && cloneDetail, JSON.stringify({ cloneList, cloneDetail }));
    assert.ok(cloneDetail.x >= cloneList.x, `clone columns left/right, got ${JSON.stringify({ cloneList, cloneDetail })}`);
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/clone-wide-dark-1600.png', animations: 'disabled' });
    await cloneHost.locator('[data-panel-id="files-changes"]').click();
    await expect(cloneHost.locator('[data-panel-id="git-commit-message"]')).toBeVisible();
    await expect(cloneHost.locator('[data-panel-id="git-suggest-button"]')).toHaveText('Proposer un message');
    await context.close();
  }
  // Context race: held old-root reads/suggest must not overwrite the new
  // Files context, and Git writes in flight block the switch outright.
  {
    const { context, page } = await openFilesTab({ width: 1440, theme: 'dark' });
    await expect(page.locator('.git-file-check')).not.toHaveCount(0);
    // A Git write in flight blocks the switch until it lands (dialog stays
    // pending; the worktree open is refused with an "en cours" toast).
    holdCommit = true;
    await expect(commitMessage(page)).toBeVisible();
    await commitMessage(page).fill('race message');
    await commitButton(page).click();
    await page.waitForTimeout(500);
    await page.locator('#files-worktrees').click();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await page.locator('.files-wt-row').nth(1).locator('button', { hasText: 'Ouvrir' }).click();
    await expect(page.locator('#toasts')).toContainText('en cours');
    await expect(page.locator('#inspector-git-bar #files-context-reset')).toBeHidden();
    holdCommit = false;
    await expect(page.locator('#toasts')).toContainText('créé');
    // Held old-root Files read + suggest: switch mid-flight, then release.
    holdOldFiles = true;
    holdSuggest = true;
    await page.locator('#files-changes').click();
    await page.locator('#refresh-files').click();
    await expect(commitMessage(page)).toBeVisible();
    await suggestButton(page).click();
    await page.waitForTimeout(500);
    await expect(suggestButton(page)).toHaveText('…');
    await page.locator('#files-worktrees').click();
    await page.locator('.files-wt-row').nth(1).locator('button', { hasText: 'Ouvrir' }).click();
    await expect(page.locator('#git-branch-label')).toContainText('feature');
    holdOldFiles = false;
    holdSuggest = false;
    // Late old-root responses land after the switch: new view keeps the new
    // context (error note for the unknown folder), never old rows or drafts.
    await expect(page.locator('#inspector-file-list .inspector-file')).toHaveCount(0);
    await expect(page.locator('#inspector-git-bar #files-context-reset')).toBeVisible();
    await expectFilesSettled(page);
    await page.locator('#inspector-git-bar #files-context-reset').click();
    await expect(page.locator('#inspector-git-bar #files-context-reset')).toBeHidden();
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
    await expect(commitMessage(page)).toBeVisible();
    await suggestButton(page).click();
    await expect(suggestButton(page)).toHaveText('…');
    await page.locator('#files-worktrees').click();
    await expect(page.locator('.files-wt-row')).toHaveCount(3);
    await page.locator('.files-wt-row').nth(1).locator('button', { hasText: 'Ouvrir' }).click();
    await expect(page.locator('#git-branch-label')).toContainText('feature');
    await page.locator('#inspector-git-bar #files-context-reset').click();
    await page.locator('#files-changes').click();
    await expect(page.locator('.git-file-check')).not.toHaveCount(0);
    await expect(commitMessage(page)).toBeVisible();
    await suggestButton(page).click();
    holdA = false;
    await page.waitForTimeout(800);
    // A resolved stale mid-B: B still owns the button and the draft is empty.
    await expect(suggestButton(page)).toHaveText('…');
    await expect(commitMessage(page)).toHaveValue('');
    holdB = false;
    await expect(commitMessage(page)).toHaveValue('message B');
    await expect(suggestButton(page)).toContainText('Proposer un message');
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
    await expect(commitBox(page)).toBeHidden();
    await expect(page.locator('.git-file-check')).toHaveCount(0);
    await page.locator('#files-worktrees').click();
    await expect(page.locator('#files-worktree-new')).toBeHidden();
    await context.close();
  }
  // English + light theme smoke.
  {
    const { context, page } = await openFilesTab({ width: 1440, language: 'en', theme: 'light' });
    await expect(page.locator('#files-history')).toContainText('History');
    await expect(page.locator('#files-worktrees')).toContainText(/Worktrees/);
    await expect(page.locator('#files-all')).toContainText('Browse');
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await page.locator('#files-history-list [data-commit-hash="3333333333333333333333333333333333333333"]').click();
    await expect(page.locator('#files-history-detail .files-commit-files button')).toHaveCount(3);
    await expect(page.locator('#files-history-detail .files-diff')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/files-workspace/history-narrow-light-1440.png', animations: 'disabled' });
    await context.close();
  }
  // Mobile 390: sub-tabs fit, history stays usable left/right stacked.
  {
    const { context, page } = await openFilesTab({ width: 390 });
    await expectToolbarRow(page);
    await expect(commitMessage(page)).toBeVisible();
    const box = await page.locator('.files-subtabs').boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= 391, JSON.stringify(box));
    await page.locator('#files-history').click();
    await expect(page.locator('#files-history-list [data-commit-hash]')).toHaveCount(2);
    await page.locator('#files-history-list [data-commit-hash="3333333333333333333333333333333333333333"]').click();
    await expect(page.locator('#files-history-detail .files-commit-files button')).toHaveCount(3);
    await expectFilesSettled(page);
    await page.screenshot({ path: 'test-results/files-workspace/history-narrow-dark-390.png', animations: 'disabled' });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Files workspace UI PASS: flat changes, viewer green/red, inline commit/suggest, left/right history without inline diffs, worktree (N) + Git-bar context, error retry, read-only, EN/light, 1440 + 390 + 1600');
} finally {
  holdOldFiles = holdSuggest = holdCommit = holdA = holdB = false;
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
