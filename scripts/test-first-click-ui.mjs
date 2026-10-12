// First-click on a link/image in a VISIBLE background conversation pane must
// BOTH activate that conversation AND open the link/image exactly once.
// Real createApp fixture, real docked split UI, real mouse/keyboard input.
// Covers: file link, inline image, modified click, text-selection drag,
// right-click (menu, no open, no focus steal), keyboard Enter, draft/scroll
// preservation, single-open. Evidence: .local/tool-panel-instances/first-click-*.
//
// Integration-ready: no fixture overrides, production sources served as-is.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createApp } from '../server.mjs';

const OUT = resolve('.local/tool-panel-instances');
await mkdir(OUT, { recursive: true });
const proof = {
  base: 'ca92929',
  steps: [],
  fixtureOverrides: [],
  ts: new Date().toISOString(),
};
const rec = (name, ok, detail = '') => {
  proof.steps.push({ name, ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`);
};

const temp = await mkdtemp(join(tmpdir(), 'prime-first-click-'));
const cwdA = join(temp, 'Atelier');
const cwdB = join(temp, 'Vtrott');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
for (const d of [cwdA, cwdB, sessionDir, dataDir, join(temp, 'agent')]) await mkdir(d, { recursive: true });
await mkdir(join(cwdA, 'docs'), { recursive: true });
await mkdir(join(cwdB, 'docs'), { recursive: true });
await writeFile(join(cwdA, 'docs', 'guide-A.md'), '# Guide A\n\nContenu Atelier A.\n');
await writeFile(
  join(cwdA, 'docs', 'pic-A.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);
await writeFile(join(cwdB, 'docs', 'guide-B.md'), '# Guide B\n\nContenu Vtrott B.\n');
await writeFile(
  join(cwdB, 'docs', 'pic.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);
const ts = new Date().toISOString();
const msg = (id, parentId, message) => ({ type: 'message', id, parentId, message: { ...message, timestamp: ts } });
await writeFile(join(sessionDir, 'fc-a.jsonl'), [
  JSON.stringify({ type: 'session', id: 'fc-a', version: 3, cwd: cwdA, timestamp: ts }),
  JSON.stringify(msg('fc-a-u', null, { role: 'user', content: 'Dossier A' })),
  JSON.stringify(msg('fc-a-a', 'fc-a-u', { role: 'assistant', model: 't/m', content: [{ type: 'text', text: 'Voir [Guide A](docs/guide-A.md) et ![Pic A](docs/pic-A.png) pour A.' }], stopReason: 'stop' })),
].join('\n') + '\n');
await writeFile(join(sessionDir, 'fc-b.jsonl'), [
  JSON.stringify({ type: 'session', id: 'fc-b', version: 3, cwd: cwdB, timestamp: ts }),
  JSON.stringify(msg('fc-b-u', null, { role: 'user', content: 'Dossier B' })),
  JSON.stringify(msg('fc-b-a', 'fc-b-u', { role: 'assistant', model: 't/m', content: [{ type: 'text', text: 'Voir [Guide B](docs/guide-B.md) et ![Pic B](docs/pic.png) pour B.' }], stopReason: 'stop' })),
].join('\n') + '\n');

const app = createApp({
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [{ id: 't/m', name: 'T', provider: 't' }], default: { model: 't/m', thinking: 'medium' } }),
    start: async () => { throw new Error('never'); },
    close: async () => {},
  },
  agentHome: join(temp, 'agent'), sessionDir, dataDir, initialCwd: cwdA,
});
await app.store.project({ cwd: cwdA });
await app.store.project({ cwd: cwdB });
await new Promise((d) => app.server.listen(0, '127.0.0.1', d));
const url = `http://127.0.0.1:${app.server.address().port}`;

const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(({ cwd, sid }) => {
    if (!localStorage.getItem('prime-studio.selection'))
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: sid, projectOverview: false }));
  }, { cwd: cwdA, sid: 'fc-a' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(String(e?.stack || e?.message || e).slice(0, 300)));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await expect(page.locator('#session-list').getByText('Dossier A', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.locator('#session-list').getByText('Dossier A', { exact: true }).click();
  await expect(page.locator('#messages a.document-link').first()).toBeVisible({ timeout: 15000 });
  rec('session-a-host', true);

  // Docking opt-in respects the actual checkbox state (modular default may be ON).
  await page.locator('#open-docking').click();
  await expect(page.locator('#docking-settings')).toBeVisible({ timeout: 10000 });
  const toggle = page.locator('#docking-toggle');
  if (!(await toggle.isChecked().catch(() => true))) await toggle.check();
  await expect(page.locator('#dock-workspace')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-close-settings').click();
  rec('docked', true);

  // Second pane via real Add Tab -> picker (project Vtrott -> Dossier B).
  const tabs0 = await page.evaluate(() => [...document.querySelectorAll('button[data-dock-tab].is-conversation')].map((t) => t.dataset.dockTab));
  const grp = await page.evaluate(() => [...document.querySelectorAll('[data-dock-group]')][0]?.dataset.dockGroup || null);
  await page.locator(`[data-dock-group="${grp}"] .dock-bar > .dock-chrome-button:not([data-dock-close])`).first().click();
  await expect(page.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-context-menu [aria-controls="docking-add-menu"]').click();
  await expect(page.locator('#docking-add-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-add-menu [data-dock-add="new-conversation"]').click();
  await expect(page.locator('#conversation-picker')).toBeVisible({ timeout: 10000 });
  await page.locator('#conversation-picker .conv-pick-row').filter({ hasText: 'Vtrott' }).first().click();
  await expect(page.locator('#conversation-picker .conv-pick-row').filter({ hasText: 'Dossier B' })).toBeVisible({ timeout: 10000 });
  await page.locator('#conversation-picker .conv-pick-row').filter({ hasText: 'Dossier B' }).first().click();
  await page.waitForTimeout(1500);
  const tabs1 = await page.evaluate(() => [...document.querySelectorAll('button[data-dock-tab].is-conversation')].map((t) => t.dataset.dockTab));
  const secondId = tabs1.find((t) => !tabs0.includes(t)) || null;
  rec('second-pane', !!secondId, JSON.stringify(tabs1));
  if (!secondId) throw new Error('no second pane');
  const paneB = page.locator(`[id="dock-view-${secondId}"]`);
  await expect(paneB.locator('a.document-link', { hasText: 'Guide B' })).toBeVisible({ timeout: 15000 });
  rec('session-b-bound', true, secondId);

  // Move submenu must be absent (removed as user-authorized): the tab menu
  // shows Add Tab only, no Move entry, no move popup, no [data-dock-move].
  await page.locator(`button[data-dock-tab="${secondId}"]`).click({ button: 'right' });
  await expect(page.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
  assert.ok(
    (await page.locator('#docking-context-menu [aria-controls="docking-move-menu"]').count()) === 0,
    'No Move submenu entry may exist in the tab context menu',
  );
  assert.ok((await page.locator('#docking-move-menu').count()) === 0, '#docking-move-menu must be absent');
  assert.ok((await page.locator('[data-dock-move]').count()) === 0, 'No [data-dock-move] items may exist');
  rec('move-absent', true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#docking-context-menu')).not.toBeVisible({ timeout: 10000 });
  // Split via real pointer drag (tab -> right edge of its group) so BOTH
  // panes stay visible.
  await page.locator(`button[data-dock-tab="${secondId}"]`).scrollIntoViewIfNeeded();
  {
    const splitFrom = await page.locator(`button[data-dock-tab="${secondId}"]`).boundingBox();
    const splitBox = await page.locator(`button[data-dock-tab="${secondId}"]`).evaluate((tab) => {
      const box = tab.closest('[data-dock-group]')?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    });
    await page.mouse.move(splitFrom.x + splitFrom.width / 2, splitFrom.y + splitFrom.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        splitFrom.x + ((splitBox.x + splitBox.width - 8 - splitFrom.x) * i) / 10,
        splitFrom.y + ((splitBox.y + splitBox.height / 2 - splitFrom.y) * i) / 10,
        { steps: 2 },
      );
    }
    await page.mouse.move(splitBox.x + splitBox.width - 8, splitBox.y + splitBox.height / 2);
    await page.mouse.up();
  }
  await page.waitForTimeout(1200);
  const visA = await page.locator('[id="dock-view-conversation"]').isVisible().catch(() => false);
  const visB = await paneB.isVisible().catch(() => false);
  rec('split-visible', visA && visB, `A=${visA} B=${visB}`);
  if (!(visA && visB)) throw new Error('split failed');

  const focusedView = () => page.evaluate(() => document.querySelector('.cvw-shell[data-focused="true"]')?.dataset.view || 'unknown');
  // Viewer contract spans baseline (#inspector-viewer) and multi-viewer (dialog.inspector-viewer:modal).
  const viewerOpen = () => page.evaluate(() => {
    const dlg = document.querySelector('dialog.inspector-viewer[open]');
    if (dlg) return true;
    const legacy = document.getElementById('inspector-viewer');
    return !!(legacy && !legacy.hidden && legacy.getClientRects().length);
  });
  const viewerText = () => page.evaluate(() => {
    const dlg = document.querySelector('dialog.inspector-viewer[open] .inspector-view-body');
    if (dlg) return dlg.innerText || '';
    return document.querySelector('#inspector-viewer .inspector-view-body')?.innerText || '';
  });
  const closeViewer = async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  };
  const imageDialogs = () => page.locator('dialog.image-viewer[open]').count().catch(() => 0);

  // --- CORE: first real click on the background link focuses AND opens once.
  await page.locator('button[data-dock-tab="conversation"]').click();
  await page.waitForTimeout(800);
  await page.locator('#composer').fill('DRAFT-A-keep');
  const viewersBefore = await page.evaluate(() => document.querySelectorAll('dialog.inspector-viewer[open]').length);
  await paneB.locator('a.document-link', { hasText: 'Guide B' }).click();
  await page.waitForTimeout(1500);
  const focusedAfter = await focusedView();
  const openAfter = await viewerOpen();
  const textAfter = openAfter ? await viewerText() : '';
  const viewersAfter = await page.evaluate(() => document.querySelectorAll('dialog.inspector-viewer[open]').length);
  rec('first-click-link-focus', focusedAfter === secondId, `after=${focusedAfter}`);
  rec('first-click-link-open', openAfter && textAfter.includes('Contenu Vtrott B'), `owner-ok=${textAfter.includes('Contenu Vtrott B')}`);
  rec('first-click-link-once', viewersAfter <= viewersBefore + 1, `viewers ${viewersBefore}->${viewersAfter}`);
  await page.screenshot({ path: join(OUT, 'first-click-link.png'), animations: 'disabled' });
  await closeViewer();
  await page.waitForFunction(() => !document.querySelector('dialog.inspector-viewer[open]'), null, { timeout: 10000 });

  // --- Image first-click (re-focus A first).
  await page.locator('button[data-dock-tab="conversation"]').click();
  await page.waitForTimeout(800);
  await closeViewer();
  const imgBtn = paneB.locator('button.inline-image-open').first();
  await expect(imgBtn).toBeVisible({ timeout: 10000 });
  await imgBtn.click();
  await page.waitForTimeout(1200);
  const dlgCount = await imageDialogs();
  const focusedImg = await focusedView();
  rec('first-click-image', dlgCount === 1 && focusedImg === secondId, `dlg=${dlgCount} focus=${focusedImg}`);
  await page.screenshot({ path: join(OUT, 'first-click-image.png'), animations: 'disabled' });
  await closeViewer();
  await page.waitForFunction(() => !document.querySelector('dialog.image-viewer[open]'), null, { timeout: 10000 });

  // --- Modified click preserved (ctrl+click opens exactly like plain click).
  await page.locator('button[data-dock-tab="conversation"]').click();
  await page.waitForTimeout(800);
  await closeViewer();
  const dlgBeforeMod = await imageDialogs();
  await paneB.locator('a.document-link', { hasText: 'Guide B' }).click({ modifiers: ['Control'] });
  await page.waitForTimeout(1200);
  const modOpen = await viewerOpen();
  rec('modified-click-preserved', modOpen, `ctrl+click opens as baseline`);
  await closeViewer();
  await page.waitForFunction(() => !document.querySelector('dialog.inspector-viewer[open]'), null, { timeout: 10000 });

  // --- Text-selection drag in the background pane: selects, opens nothing.
  await page.locator('button[data-dock-tab="conversation"]').click();
  await page.waitForTimeout(800);
  await closeViewer();
  const viewersPreSel = await page.evaluate(() => document.querySelectorAll('dialog.inspector-viewer[open]').length);
  // Plain TEXT drag in the inactive pane (message body, never the link/image):
  // read mid-drag (stable DOM, no flush fired yet) and after release.
  const userText = paneB.locator('.message.user .message-body').first();
  await expect(userText).toBeVisible({ timeout: 10000 });
  const tbox = await userText.boundingBox();
  const readSel = () => page.evaluate(() => {
    const s = window.getSelection?.();
    return { len: String(s?.toString() || '').length, text: String(s?.toString() || '').slice(0, 40) };
  });
  await page.evaluate(() => {
    window.__selLog = [];
    window.__selEvents = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'selectionchange']) {
      document.addEventListener(t, (e) => {
        const s = window.getSelection?.();
        window.__selEvents.push(t);
        if (t === 'click') window.__selLog.push(`click-capture:${String(s?.toString() || '').length}`);
      }, true);
    }
    document.addEventListener('selectionchange', () => {
      const s = window.getSelection?.();
      window.__selLog.push(`selchange:${String(s?.toString() || '').length}`);
    });
  });
  await page.evaluate(() => {
    const body = [...document.querySelectorAll('.cvw-shell')].find((s) => s.dataset.view !== 'conversation')?.querySelector('.message.user .message-body');
    window.__textNode = body?.firstChild || null;
  });
  await page.mouse.move(tbox.x + 8, tbox.y + tbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tbox.x + (tbox.width - 16) / 2, tbox.y + tbox.height / 2, { steps: 5 });
  await page.waitForTimeout(300);
  const selMid = await readSel();
  await page.mouse.move(tbox.x + tbox.width - 8, tbox.y + tbox.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const selPost = await readSel();
  const viewersPostSel = await page.evaluate(() => document.querySelectorAll('dialog.inspector-viewer[open]').length);
  const focusPostSel = await focusedView();
  const selDbg = await page.evaluate(() => {
    const body = [...document.querySelectorAll('.cvw-shell')].find((s) => s.dataset.view !== 'conversation')?.querySelector('.message.user .message-body');
    const tn = window.__textNode || null;
    return {
      log: window.__selLog || [],
      events: window.__selEvents || [],
      textNodeSame: tn ? body?.firstChild === tn : null,
      textNodeConnected: tn ? !!tn.isConnected : null,
      bodyChildren: body?.childNodes.length ?? null,
    };
  });
  proof.selectionReads = { mid: selMid, post: selPost, dbg: selDbg };
  // A 0==0 pass is forbidden: the drag must demonstrably form a selection
  // mid-gesture AND retain it after release (no node replacement: the
  // message text node must survive the focus paint), while opening nothing.
  const retained = selMid.len > 0 && selPost.len > 0 && selDbg.textNodeSame === true;
  rec('selection-preserved', retained && viewersPostSel === viewersPreSel && focusPostSel === secondId, `mid=${JSON.stringify(selMid)} post=${JSON.stringify(selPost)} sameNode=${selDbg.textNodeSame} viewers=${viewersPostSel} focus=${focusPostSel}`);

  // --- Right-click on the link: no viewer, no focus steal (menu is file-links territory).
  const focusPreR = await focusedView();
  await paneB.locator('a.document-link', { hasText: 'Guide B' }).click({ button: 'right' });
  await page.waitForTimeout(800);
  const viewersPostR = await page.evaluate(() => document.querySelectorAll('dialog.inspector-viewer[open]').length);
  const focusPostR = await focusedView();
  rec('right-click-preserved', viewersPostR === viewersPreSel && focusPostR === focusPreR, `viewers=${viewersPostR} focus=${focusPostR}`);
  await page.keyboard.press('Escape').catch(() => {});

  // --- Keyboard: Enter on the background link opens with correct owner.
  await page.locator('button[data-dock-tab="conversation"]').click();
  await page.waitForTimeout(800);
  await closeViewer();
  await paneB.locator('a.document-link', { hasText: 'Guide B' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const kbOpen = await viewerOpen();
  const kbText = kbOpen ? await viewerText() : '';
  rec('keyboard-enter-preserved', kbOpen && kbText.includes('Contenu Vtrott B'), `owner-ok=${kbText.includes('Contenu Vtrott B')}`);
  await closeViewer();
  await page.waitForFunction(() => !document.querySelector('dialog.inspector-viewer[open]'), null, { timeout: 10000 });

  // --- Draft/scroll survive the round-trip.
  await page.locator('button[data-dock-tab="conversation"]').click();
  await page.waitForTimeout(800);
  const draftBack = await page.locator('#composer').inputValue().catch(() => '');
  rec('draft-preserved', draftBack === 'DRAFT-A-keep', `draft=${draftBack.slice(0, 30)}`);

  // --- Inactive PRIMARY link/image after B focused (host transcript path,
  // exercises the guarded host activation allow-branch).
  await page.locator(`button[data-dock-tab="${secondId}"]`).click();
  await page.waitForTimeout(800);
  if ((await focusedView()) !== secondId) throw new Error('B not focused for primary-background step');
  await page.locator('#messages a.document-link', { hasText: 'Guide A' }).click();
  await page.waitForTimeout(1200);
  const focusedPrim = await focusedView();
  const primOpen = await viewerOpen();
  const primText = primOpen ? await viewerText() : '';
  rec('inactive-primary-link', focusedPrim === 'conversation' && primOpen && primText.includes('Contenu Atelier A'), `focus=${focusedPrim} owner-ok=${primText.includes('Contenu Atelier A')}`);
  await page.screenshot({ path: join(OUT, 'first-click-primary-link.png'), animations: 'disabled' });
  await closeViewer();
  await page.waitForFunction(() => !document.querySelector('dialog.inspector-viewer[open]'), null, { timeout: 10000 });
  await page.locator(`button[data-dock-tab="${secondId}"]`).click();
  await page.waitForTimeout(800);
  const primImgBtn = page.locator('#messages button.inline-image-open').first();
  await expect(primImgBtn).toBeVisible({ timeout: 10000 });
  await primImgBtn.click();
  await page.waitForTimeout(1200);
  const primDlg = await imageDialogs();
  const focusedPrimImg = await focusedView();
  rec('inactive-primary-image', primDlg === 1 && focusedPrimImg === 'conversation', `dlg=${primDlg} focus=${focusedPrimImg}`);
  await page.screenshot({ path: join(OUT, 'first-click-primary-image.png'), animations: 'disabled' });
  await closeViewer();
  await page.waitForFunction(() => !document.querySelector('dialog.image-viewer[open]'), null, { timeout: 10000 });

  proof.errors = errors;
  expect(errors).toEqual([]);
} finally {
  await browser.close().catch(() => {});
  await app.close();
  const fs = await import('node:fs/promises');
  await fs.writeFile(join(OUT, 'first-click-proof.json'), JSON.stringify(proof, null, 2));
  await rm(temp, { recursive: true, force: true });
}
const failed = proof.steps.filter((s) => !s.ok);
console.log(failed.length ? `FAILING (${failed.length})` : 'ALL OK');
process.exitCode = failed.length ? 1 : 0;
