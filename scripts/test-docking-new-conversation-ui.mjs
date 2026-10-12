// Isolated new-conversation UI reproduction (modular/docked layout).
//
// SCOPE: this file ONLY creates scripts/test-docking-new-conversation-ui.mjs
// plus its OWN runtime artifacts under .local/layout-new-conversation/
// (qa-* captures + qa-* proof JSON). No other Studio source is edited.
// NEVER: production server, real provider account, real model, user Lab 62542,
// installed Studio, install/build/commit/publish. Seeding uses the real
// createApp fixture API plus normal UI input and a stub runtime (records
// starts, never streams). Captures are genuine screenshots only: never force
// hidden/classes/DOM state for visuals. Reading refs/storage/scroll through
// page.evaluate for comparison is allowed and is NOT UI forcing.
//
// BASELINE (pre-root-fix): #new-session / Ctrl+N rebind the focused pane in
// place (no new tab); new docked panes are blank until focus-away/back with no
// welcome prompt suggestions. This script EXPECTS the NEW product contract:
// new chats add a NEW tab (never replace), new panes show an immediately
// usable composer + prompt suggestions, suggestions fill the owning pane only
// with no model run. Pre-fix runs therefore report status "reproduced" with
// the exact gaps; post-fix runs report "pass".
// NOTE: older scripts (test-docking-workspace-ui.mjs M2-fast N1 asserts,
// new-session-cwd expectations) assert rebind-in-place; the user requirement
// overrides them. They are NOT edited here — flagged to parent instead.

import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

// --reproduce replays the pre-fix product snapshot (source-baseline.json) via
// Playwright route.fulfill: static /public/* requests are served the exact
// before texts. No product file is rewritten. Default mode tests the live tree.
const REPRODUCE = process.argv.includes('--reproduce');
const OUT_ROOT = resolve('.local/layout-new-conversation/captures');
const PROOF_PATH = resolve(
  REPRODUCE
    ? '.local/layout-new-conversation/qa-new-conversation-reproduce-proof.json'
    : '.local/layout-new-conversation/qa-new-conversation-proof.json',
);
const shotName = (n) => {
  const base = String(n).replace(/^qa-/, '');
  return REPRODUCE ? `qa-repro-${base}` : `qa-${base}`;
};

const temp = await mkdtemp(join(tmpdir(), 'prime-newconv-ui-'));
const cwdA = join(temp, 'Atelier');
const cwdB = join(temp, 'Vtrott');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await mkdir(cwdA, { recursive: true });
await mkdir(cwdB, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const entry = (id, role, content) => ({
  type: 'message',
  id,
  message: { role, content, timestamp: Date.now() },
});
async function seedSession(file, id, projectCwd, title, n) {
  const records = [{ type: 'session', id, cwd: projectCwd, version: 3, timestamp: new Date().toISOString() }];
  let parent = null;
  const link = (r) => {
    r.parentId = parent;
    records.push(r);
    parent = r.id;
  };
  link(entry(`${id}-u0`, 'user', title));
  for (let i = 0; i < n; i++) {
    link(
      entry(
        `${id}-a${i}`,
        'assistant',
        `Paragraphe ${i + 1} : remplissage pour defiler. ` + 'texte. '.repeat(20),
      ),
    );
    link(entry(`${id}-u${i + 1}`, 'user', `Suite ${i + 1} : que verifier ensuite ?`));
  }
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
}
await seedSession(join(sessionDir, 'conv-alpha.jsonl'), 'conv-alpha', cwdA, 'Alpha : calibrer la sortie', 12);
await seedSession(
  join(sessionDir, 'conv-beta.jsonl'),
  'conv-beta',
  cwdA,
  'Beta : preparer la distribution',
  3,
);

const starts = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/newconv', name: 'Fixture model', provider: 'fixture', reasoning: true }],
    default: { model: 'fixture/newconv', thinking: 'medium' },
  }),
  async start(input) {
    starts.push({ sessionId: input.sessionId || null });
    let done2;
    const done = new Promise((r) => {
      done2 = r;
    });
    return {
      done,
      async finish(s = 'completed') {
        const res = { kind: 'done', sessionId: input.sessionId, status: s, code: 0 };
        input.onEvent(res);
        done2(res);
        return res;
      },
      cancel() {
        return this.finish('stopped');
      },
    };
  },
  async close() {},
};

const app = createApp({ runtime, agentHome: join(temp, 'agent'), sessionDir, dataDir, initialCwd: cwdA });
await app.store.project({ cwd: cwdA });
await app.store.project({ cwd: cwdB });
await mkdir(join(temp, 'agent'), { recursive: true });
await new Promise((d) => app.server.listen(0, '127.0.0.1', d));
const url = `http://127.0.0.1:${app.server.address().port}`;

const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
const results = [];
function rec(name, ok, detail = '') {
  results.push({ name, ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? 'ok' : 'REPRO'} - ${name}${detail ? ` :: ${detail}` : ''}`);
}
async function shot(name) {
  await mkdir(OUT_ROOT, { recursive: true });
  await page.screenshot({ path: join(OUT_ROOT, shotName(name)), animations: 'disabled' });
}
// Real Add Tab -> picker -> new-empty flow. Returns the new tab id or null.
// Colon-bearing conv: ids use quoted-attribute selectors (valid CSS); the
// dock-view frame uses [id="..."] (never an unescaped #id selector).
async function addTabNewConversation(p) {
  const before = await convTabs(p);
  const grp = await p.evaluate(
    () => [...document.querySelectorAll('[data-dock-group]')][0]?.dataset.dockGroup || null,
  );
  await p
    .locator(`[data-dock-group="${grp}"]`)
    .locator('.dock-bar > .dock-chrome-button:not([data-dock-close])')
    .first()
    .click();
  await expect(p.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
  await p.locator('#docking-context-menu [aria-haspopup="menu"]').click();
  await expect(p.locator('#docking-add-menu')).toBeVisible({ timeout: 10000 });
  await p.locator('#docking-add-menu [data-dock-add="new-conversation"]').click();
  if (
    await p
      .locator('#conversation-picker')
      .isVisible()
      .catch(() => false)
  ) {
    await p.locator('#conversation-picker .conv-pick-row').first().click();
    const nr = p.locator('#conversation-picker .conv-pick-row.is-new');
    if (await nr.count()) await nr.first().click();
    else await p.locator('#conversation-picker .conv-pick-row').first().click();
  }
  await p.waitForTimeout(1200);
  const after = await convTabs(p);
  return after.find((t) => !before.includes(t)) || null;
}
async function convTabs(p) {
  return p.evaluate(() =>
    [...document.querySelectorAll('button[data-dock-tab].is-conversation')].map((t) => t.dataset.dockTab),
  );
}
async function sidecar(p) {
  return p.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.docking.conversations') || 'null');
    } catch {
      return null;
    }
  });
}
async function paneComposerVisible(p, tabId) {
  return p.evaluate((id) => {
    const tab = document.querySelector(`button[data-dock-tab="${CSS.escape(id)}"]`);
    const group = tab?.closest('[data-dock-group]');
    const active = group?.querySelector('button[aria-selected="true"]')?.dataset.dockTab;
    if (active !== id) return { active: false };
    const frame = document.getElementById(`dock-view-${id}`);
    if (!frame) return { active: true, noFrame: true };
    const ta = frame.querySelector(id === 'conversation' ? '#composer' : '[data-cvw="composer"]');
    if (!ta) return { active: true, missing: true };
    const r = ta.getBoundingClientRect();
    return {
      active: true,
      visible: r.width > 5 && r.height > 5,
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }, tabId);
}
async function tabGroup(p, id) {
  return p.evaluate(
    (tid) =>
      document.querySelector(`button[data-dock-tab="${CSS.escape(tid)}"]`)?.closest('[data-dock-group]')
        ?.dataset.dockGroup || null,
    id,
  );
}
async function sidecarEntry(p, id) {
  const sc = await sidecar(p);
  return (sc?.entries || []).find((e) => e.id === id) || null;
}
async function paneSuggestions(p, tabId) {
  return p.evaluate((id) => {
    const frame = document.getElementById(`dock-view-${id}`);
    if (!frame) {
      // classic/host fallback: global welcome cards
      const cards = [...document.querySelectorAll('#welcome .starter-card')].map(
        (b) => b.getAttribute('data-prompt') || '',
      );
      const w = document.getElementById('welcome');
      const r = w?.getBoundingClientRect();
      return { scope: 'host', count: cards.length, welcomeVisible: !!w && !w.hidden && (r?.height || 0) > 5 };
    }
    const cards = [...frame.querySelectorAll('.starter-card, [data-prompt]')].map((b) =>
      (b.getAttribute('data-prompt') || '').slice(0, 40),
    );
    return { scope: 'pane', count: cards.length, sample: cards.slice(0, 2) };
  }, tabId);
}

let page, context;
let proofWritten = false;
async function writeProof(status, notes) {
  const payload = {
    version: 1,
    status,
    results,
    runs: { starts: starts.length },
    errors,
    notes,
    at: new Date().toISOString(),
  };
  await mkdir(dirname(PROOF_PATH), { recursive: true });
  await writeFile(PROOF_PATH, JSON.stringify(payload, null, 2));
  proofWritten = true;
}

try {
  await mkdir(OUT_ROOT, { recursive: true });
  context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(
    ({ cwd, sid }) => {
      if (!localStorage.getItem('prime-studio.selection'))
        localStorage.setItem(
          'prime-studio.selection',
          JSON.stringify({ cwd, sessionId: sid, projectOverview: false }),
        );
    },
    { cwd: cwdA, sid: 'conv-alpha' },
  );
  if (REPRODUCE) {
    const base = JSON.parse(
      await readFile(resolve('.local/layout-new-conversation/source-baseline.json'), 'utf8'),
    );
    const snaps = {
      '/public/app.js': base['public/app.js'],
      '/public/conversation-views.js': base['public/conversation-views.js'],
      '/public/styles.css': base['public/styles.css'],
    };
    for (const [p, body] of Object.entries(snaps)) {
      await context.route(`**${p}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: p.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          body,
        }),
      );
    }
  }
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(String(e?.stack || e?.message || e).slice(0, 800)));
  page.on('dialog', async (d) => {
    errors.push(`native dialog: ${d.message()}`);
    await d.dismiss().catch(() => {});
  });

  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await page
    .locator('#session-list .session-select')
    .filter({ hasText: 'calibrer' })
    .first()
    .click()
    .catch(() => {});
  await page.locator('#open-docking').click();
  await expect(page.locator('#docking-settings')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-toggle').check();
  await expect(page.locator('#dock-workspace')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-close-settings').click();
  rec('docked-boot', true, 'modular layout active at 1600px');

  // Second owned pane via real Add Tab -> picker -> new empty (Atelier).
  const tabs0 = await convTabs(page);
  const secondId = await addTabNewConversation(page);
  const tabs1 = await convTabs(page);
  rec('addtab-second-pane', !!secondId, `tabs ${JSON.stringify(tabs0)} -> ${JSON.stringify(tabs1)}`);

  // Drafts + scroll on both owned panes (host + dynamic if present).
  await page
    .locator('button[data-dock-tab="conversation"]')
    .click()
    .catch(() => {});
  await page.locator('#composer').fill('DRAFT-PANE-A-ne-pas-perdre');
  let dynId = (await convTabs(page)).find((t) => t !== 'conversation') || null;
  let dynDraftOk = false;
  if (dynId) {
    await page.locator(`button[data-dock-tab="${dynId}"]`).click();
    const dynTa = page.locator(`[id="dock-view-${dynId}"] [data-cvw="composer"]`);
    if (await dynTa.count()) {
      await dynTa.fill('DRAFT-PANE-B-ne-pas-perdre');
      dynDraftOk = (await dynTa.inputValue()) === 'DRAFT-PANE-B-ne-pas-perdre';
    }
  }
  rec('two-owned-drafts', dynDraftOk, `dyn=${dynId} ok=${dynDraftOk}`);
  await shot('qa-two-panes.png');

  // --- REPRO 1: blank new pane (composer + suggestions immediately, no focus-away) ---
  // Use Add Tab new-conversation again and inspect the FRESH pane before touching focus.
  const tabsBefore = await convTabs(page);
  const sidecarBefore = await sidecar(page);
  const freshId = await addTabNewConversation(page);
  const tabsAfterAdd = await convTabs(page);
  let composerState = null,
    suggState = null;
  if (freshId) {
    composerState = await paneComposerVisible(page, freshId);
    suggState = await paneSuggestions(page, freshId);
    await shot('qa-fresh-pane-immediate.png');
    // Focus-away/back workaround probe (documents the reported symptom only).
    await page.locator('button[data-dock-tab="conversation"]').click();
    await page.locator(`button[data-dock-tab="${freshId}"]`).click();
    await page.waitForTimeout(600);
    const afterRefocus = await paneComposerVisible(page, freshId);
    composerState.afterRefocus = afterRefocus;
    await shot('qa-fresh-pane-after-refocus.png');
  }
  const composerImmediateOk = !!(composerState && composerState.visible);
  const suggOk = !!(suggState && suggState.count > 0);
  rec('fresh-pane-composer-immediate', composerImmediateOk, JSON.stringify(composerState));
  rec('fresh-pane-suggestions-immediate', suggOk, JSON.stringify(suggState));

  // --- REPRO 2: #new-session button must ADD a tab, never replace ---
  const preBtn = await convTabs(page);
  const preSidecar = await sidecar(page);
  const draftsPre = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
  await page
    .locator(`button[data-dock-tab="${freshId || 'conversation'}"]`)
    .click()
    .catch(() => {});
  await page.locator('#new-session').click();
  await page.waitForTimeout(1200);
  const postBtn = await convTabs(page);
  const addedBtn =
    postBtn.length === preBtn.length + 1 && postBtn.filter((t) => !preBtn.includes(t)).length === 1;
  const preservedBtn = preBtn.every((t) => postBtn.includes(t));
  const hostDraftKept =
    (
      (await page
        .locator('#composer')
        .inputValue()
        .catch(() => '')) || ''
    ).includes('DRAFT-PANE-A') || Object.values(draftsPre).some((v) => String(v).includes('DRAFT-PANE-A'));
  rec(
    'new-session-adds-tab',
    addedBtn && preservedBtn,
    `before=${JSON.stringify(preBtn)} after=${JSON.stringify(postBtn)}`,
  );
  await shot('qa-after-new-session-btn.png');

  // --- REPRO 3: Ctrl+N must ADD a tab ---
  const preCtrl = await convTabs(page);
  await page.keyboard.press('Control+n');
  await page.waitForTimeout(1200);
  const postCtrl = await convTabs(page);
  const addedCtrl = postCtrl.length === preCtrl.length + 1;
  rec('ctrl-n-adds-tab', addedCtrl, `before=${preCtrl.length} after=${postCtrl.length}`);
  await shot('qa-after-ctrl-n.png');

  // --- Suggestion click fills the OWNING pane only, starts no run ---
  const suggTab = freshId || secondId || 'conversation';
  await page
    .locator(`button[data-dock-tab="${suggTab}"]`)
    .click()
    .catch(() => {});
  const hostBefore = await page
    .locator('#composer')
    .inputValue()
    .catch(() => '');
  const cardScope = await page.evaluate((id) => {
    const f = document.getElementById(`dock-view-${id}`);
    const card = f
      ? f.querySelector('.welcome [data-prompt]')
      : document.querySelector('#welcome [data-prompt]');
    if (!card) return { found: false };
    card.click();
    return { found: true, prompt: (card.getAttribute('data-prompt') || '').slice(0, 40) };
  }, suggTab);
  await page.waitForTimeout(600);
  const paneText = await page.evaluate((id) => {
    const f = document.getElementById(`dock-view-${id}`);
    const ta = f ? f.querySelector('[data-cvw="composer"]') : null;
    return {
      pane: ta ? ta.value.slice(0, 60) : null,
      host: document.getElementById('composer')?.value.slice(0, 60) || '',
    };
  }, suggTab);
  const suggFillsOwner =
    cardScope.found && (paneText.pane || paneText.host).length > 0 && starts.length === 0;
  // Owner check: a dynamic pane's text must land in its own composer, never the parked host.
  const ownerOk = suggTab === 'conversation' ? true : (paneText.pane || '').length > 0;
  rec('suggestion-fills-owner', suggFillsOwner && ownerOk, JSON.stringify({ ...cardScope, paneText }));
  await shot('qa-suggestion-fill.png');

  // --- Project-menu New session from ANOTHER project (no prior selectProject) ---
  await page
    .locator('button[data-dock-tab="conversation"]')
    .click()
    .catch(() => {});
  const oldGroup = await tabGroup(page, 'conversation');
  const tabsPreMenu = await convTabs(page);
  const draftsPreMenu = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
  const draftAAlive = Object.values(draftsPreMenu).some((v) => String(v).includes('DRAFT-PANE-A'));
  await page
    .locator('#session-list .project-entry')
    .filter({ hasText: 'Vtrott' })
    .locator('.project-more')
    .click();
  await expect(page.locator('#project-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#project-menu [data-project-action="new-session"]').click();
  await page.waitForTimeout(1500);
  const tabsPostMenu = await convTabs(page);
  const menuFresh = tabsPostMenu.find((t) => !tabsPreMenu.includes(t)) || null;
  const menuOwner = menuFresh ? await sidecarEntry(page, menuFresh) : null;
  const norm = (s) =>
    String(s || '')
      .replaceAll('\\', '/')
      .replace(/\/$/, '')
      .toLowerCase();
  const menuOwnerOk = !!menuFresh && !!menuOwner && norm(menuOwner.projectCwd) === norm(cwdB);
  rec(
    'project-menu-adds-tab',
    !!menuFresh && tabsPreMenu.every((t) => tabsPostMenu.includes(t)) && menuOwnerOk,
    `fresh=${menuFresh} owner=${menuOwner?.projectCwd || '?'} expect=${cwdB}`,
  );
  rec(
    'project-menu-same-group',
    !!menuFresh && (await tabGroup(page, menuFresh)) === oldGroup && !!oldGroup,
    `oldGroup=${oldGroup} newGroup=${menuFresh ? await tabGroup(page, menuFresh) : '?'}`,
  );
  // Old tab keeps its session binding and draft after the menu creation.
  let oldBindingOk = false;
  try {
    await page.locator('button[data-dock-tab="conversation"]').click();
    await expect(page.locator('#detail-session-id')).toContainText('conv-alpha', { timeout: 10000 });
    oldBindingOk = true;
  } catch (e) {
    oldBindingOk = false;
  }
  const draftsPostMenu = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
  const oldDraftOk = Object.values(draftsPostMenu).some((v) => String(v).includes('DRAFT-PANE-A'));
  rec('project-menu-old-binding', oldBindingOk, 'focused old tab must still own conv-alpha');
  rec('project-menu-old-draft', draftAAlive && oldDraftOk, `draftAAlive=${draftAAlive} kept=${oldDraftOk}`);
  await shot('qa-project-menu.png');

  // --- Project creation via UI while a secondary tab is focused ---
  const cwdC = join(temp, 'Gamma');
  await mkdir(cwdC, { recursive: true });
  const focusTab = (await convTabs(page)).find((t) => t !== 'conversation') || 'conversation';
  await page
    .locator(`button[data-dock-tab="${focusTab}"]`)
    .click()
    .catch(() => {});
  const focusGroup = await tabGroup(page, focusTab);
  const tabsPreProj = await convTabs(page);
  await page.locator('#add-project').click();
  await expect(page.locator('#project-dialog')).toBeVisible({ timeout: 10000 });
  await page.locator('#project-cwd').fill(cwdC);
  await page.locator('#project-name').fill('Gamma');
  await page.locator('#project-submit').click();
  await page.waitForTimeout(1800);
  const tabsPostProj = await convTabs(page);
  const projAdded =
    tabsPostProj.length === tabsPreProj.length + 1 && tabsPreProj.every((t) => tabsPostProj.includes(t));
  const overviewHidden = await page.evaluate(
    () => document.getElementById('project-overview')?.hidden !== false,
  );
  const projFresh = tabsPostProj.find((t) => !tabsPreProj.includes(t)) || null;
  const projComposer = projFresh ? await paneComposerVisible(page, projFresh) : null;
  const projSugg = projFresh ? await paneSuggestions(page, projFresh) : null;
  rec(
    'project-create-adds-tab',
    projAdded,
    `before=${tabsPreProj.length} after=${tabsPostProj.length} fresh=${projFresh}`,
  );
  rec(
    'project-create-same-group',
    !!projFresh && (await tabGroup(page, projFresh)) === focusGroup && !!focusGroup,
    `focusGroup=${focusGroup} newGroup=${projFresh ? await tabGroup(page, projFresh) : '?'}`,
  );
  rec('project-create-overview-clear', overviewHidden, 'overview must not trap the new pane');
  rec('project-create-composer', !!(projComposer && projComposer.visible), JSON.stringify(projComposer));
  rec('project-create-suggestions', !!(projSugg && projSugg.count > 0), JSON.stringify(projSugg));
  await shot('qa-project-create.png');

  // --- Shell welcome chrome report (icons/i18n, for parent) ---
  const welcomeChrome = await page.evaluate((id) => {
    const f = id ? document.getElementById(`dock-view-${id}`) : null;
    const w = f ? f.querySelector('.welcome') : null;
    if (!w) return { present: false };
    return {
      present: true,
      visible: !w.hidden,
      svg: w.querySelectorAll('svg').length,
      dataIcon: w.querySelectorAll('[data-icon]').length,
      i18n: w.querySelectorAll('[data-i18n]').length,
      cards: w.querySelectorAll('[data-prompt]').length,
      dupIds: w.querySelectorAll('[id]').length,
    };
  }, projFresh || freshId);
  rec('welcome-chrome-present', welcomeChrome.present !== false, JSON.stringify(welcomeChrome));

  // --- Tab cap refusal (bounded): fill to 8 mounted, one more must refuse cleanly ---
  let capTabs = await convTabs(page);
  let guard = 0;
  while (capTabs.length < 8 && guard < 6) {
    guard++;
    const nid = await addTabNewConversation(page);
    if (!nid) break;
    capTabs = await convTabs(page);
  }
  const atCap = capTabs.length >= 8;
  const nidExtra = atCap ? await addTabNewConversation(page) : null;
  const capTabsAfter = await convTabs(page);
  const capRefused = !atCap
    ? true
    : nidExtra === null && capTabsAfter.length === capTabs.length && starts.length === 0;
  rec(
    'tab-cap-refusal',
    capRefused,
    `tabs=${capTabsAfter.length} atCap=${atCap} extra=${nidExtra} starts=${starts.length}`,
  );
  await shot('qa-tab-cap.png');

  // --- Runtime language switch: clone cards + inserted prompt translate ---
  // Real settings UI (#open-settings -> #language-select), never storage forcing.
  const langTab = projFresh || freshId || secondId;
  let enOk = false;
  let enDetail = '';
  try {
    if (!langTab) throw new Error('no empty dynamic tab for the language switch');
    await page.locator(`button[data-dock-tab="${langTab}"]`).click();
    const frCard = await page.evaluate((id) => {
      const card = document.getElementById(`dock-view-${id}`)?.querySelector('.welcome [data-prompt]');
      return card
        ? { text: card.textContent.trim().slice(0, 60), prompt: card.getAttribute('data-prompt') }
        : null;
    }, langTab);
    if (!frCard) throw new Error('no welcome card in the pane (baseline has no clone)');
    await page.locator('#open-settings').click();
    await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
    await page.locator('#language-select').selectOption('en');
    await page.waitForTimeout(900);
    await page
      .locator('#settings-dialog [data-close-dialog]')
      .click()
      .catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(600);
    const enCard = await page.evaluate((id) => {
      const card = document.getElementById(`dock-view-${id}`)?.querySelector('.welcome [data-prompt]');
      const host = document.querySelector('#welcome [data-prompt]');
      return card
        ? {
            text: card.textContent.trim().slice(0, 60),
            prompt: card.getAttribute('data-prompt'),
            hostPrompt: host?.getAttribute('data-prompt') || null,
          }
        : null;
    }, langTab);
    const translated = !!enCard && enCard.prompt !== frCard.prompt && enCard.prompt === enCard.hostPrompt;
    const startsPreEn = starts.length;
    await page.evaluate((id) => {
      document.getElementById(`dock-view-${id}`)?.querySelector('.welcome [data-prompt]')?.click();
    }, langTab);
    await page.waitForTimeout(600);
    const enPaneText = await page.evaluate((id) => {
      const ta = document.getElementById(`dock-view-${id}`)?.querySelector('[data-cvw="composer"]');
      return ta ? ta.value.slice(0, 80) : null;
    }, langTab);
    enOk =
      translated &&
      !!enPaneText &&
      enPaneText === enCard.prompt?.slice(0, 80) &&
      starts.length === startsPreEn;
    enDetail = `fr=${JSON.stringify(frCard?.text)} en=${JSON.stringify(enCard?.text)} paneMatch=${enPaneText === enCard?.prompt?.slice(0, 80)} runs=${starts.length - startsPreEn}`;
    await shot('qa-lang-en.png');
    await page.locator('#open-settings').click();
    await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
    await page.locator('#language-select').selectOption('fr');
    await page.waitForTimeout(900);
    await page
      .locator('#settings-dialog [data-close-dialog]')
      .click()
      .catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(600);
  } catch (e) {
    enDetail = `switch failed: ${String(e?.message || e).slice(0, 200)}`;
    enOk = false;
  }
  rec('en-clone-cards-translate', enOk, enDetail);

  // --- Reload restores new empty tabs (sidecar nonces) ---
  const sidecarNow = await sidecar(page);
  const draftsNow = await page.evaluate(() => {
    try {
      return Object.keys(JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}'));
    } catch {
      return [];
    }
  });
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const tabsReload = await convTabs(page).catch(() => []);
  rec(
    'reload-keeps-tabs',
    tabsReload.length >= 2,
    `tabs=${JSON.stringify(tabsReload)} sidecarEntries=${sidecarNow?.entries?.length ?? '?'} draftKeys=${draftsNow.length}`,
  );
  // Restored empty tabs show the OWNER project in the welcome label (rebound post-bootstrap).
  let labelOk = false;
  let labelDetail = '';
  try {
    const scReload = await sidecar(page);
    const empties = (scReload?.entries || []).filter((e) => e.kind === 'new' && !e.sessionId);
    if (!empties.length) throw new Error('no restored empty tabs');
    const checks = [];
    // Strict freshness: read WITHOUT focusing any tab, so the labels must
    // already be rebound after bootstrap/projects updates (no refocus crutch).
    for (const e of empties) {
      const got = await page.evaluate((id) => {
        const w = document.getElementById(`dock-view-${id}`)?.querySelector('.welcome');
        if (!w) return null;
        // Text freshness counts even while the parked pane stays hidden.
        return (w.querySelector('.welcome-project')?.textContent || '').trim();
      }, e.id);
      const want =
        String(e.projectCwd || '')
          .split(/[\\/]/)
          .filter(Boolean)
          .pop() || '';
      checks.push({ id: e.id, want, got, ok: !!got && !!want && got.includes(want) });
    }
    labelOk = checks.length > 0 && checks.every((c) => c.ok);
    labelDetail = JSON.stringify(checks.map((c) => `${c.id}:${JSON.stringify(c.got)}/${c.want}`)).slice(
      0,
      400,
    );
    await shot('qa-reload-label.png');
  } catch (e) {
    labelDetail = `label check failed: ${String(e?.message || e).slice(0, 200)}`;
  }
  rec('reload-welcome-owner-label', labelOk, labelDetail);
  await shot('qa-after-reload.png');

  rec('no-model-runs', starts.length === 0, `starts=${starts.length}`);
  rec('no-page-errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  const mode = REPRODUCE ? 'baseline (route.fulfill before-texts)' : 'fixed tree';
  const status = failed.length ? 'reproduced' : 'pass';
  await writeProof(
    status,
    failed.length
      ? [
          `${mode} gaps: ${failed.join(', ')}`,
          `sidecar before=${JSON.stringify(sidecarBefore)?.slice(0, 300)}`,
          `welcomeChrome=${JSON.stringify(welcomeChrome)}`,
          'old rebind-in-place asserts in test-docking-workspace-ui.mjs M2-fast N1 + new-session-cwd expectations are stale per NEW requirement — NOT edited, flagged to parent',
          'read-only not UI-feasible in fixture (server access-mode driven) — recorded, not tested',
        ]
      : [`all NEW-contract checks pass on ${mode}`, `welcomeChrome=${JSON.stringify(welcomeChrome)}`],
  );
} catch (error) {
  try {
    await page?.screenshot({ path: join(OUT_ROOT, shotName('failure.png')) }).catch(() => {});
  } catch {}
  // Harness exceptions are infra errors, never product reproduction evidence.
  if (!proofWritten) {
    try {
      await writeProof('error', [`harness error: ${String(error?.message || error).slice(0, 800)}`]);
    } catch {}
  }
  throw error;
} finally {
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
