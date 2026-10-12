// Session-switch regression for docked Roadmap stuck on Loading.
// Real app + isolated fixture stub runtime only. No Studio62542, no real models.
// Fast A->B->A same/different projects, visible/hidden/reopened, late/error,
// slash/case canonical variant (actual server resolve behavior), no stale docs,
// edit preservation, bounded GETs.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOUND_MS = 8000;
const source = await (
  await import('node:fs/promises')
).readFile(new URL('../public/roadmap.js', import.meta.url), 'utf8');
// Static guards: canonical identity + error render + pending bypass must exist.
// Keep POSIX case distinct: only Windows-looking paths fold case.
for (const needle of ['queuedRefresh', 'AbortController', 'REFRESH_TIMEOUT_MS']) {
  assert.ok(source.includes(needle), `roadmap.js must contain ${needle}`);
}
// Optional behavioral proof against a baseline snapshot without touching the product:
// node scripts/test-roadmap-session-switch-ui.mjs --baseline=<path-to-baseline-roadmap.js>
// Normal mode (package test:roadmap) runs the fixed regression only and never reads .local/.
const baselineOpt = process.argv.find((arg) => arg.startsWith('--baseline=')) || '';
const baselineFile = baselineOpt ? resolve(baselineOpt.slice('--baseline='.length)) : null;

const fixture = await createRoadmapFixture();
{
  let doc = await fixture.app.roadmap.read(fixture.otherCwd);
  doc = await fixture.app.roadmap.mutate(fixture.otherCwd, {
    action: 'init',
    expectedRevision: doc.revision,
  });
  await fixture.app.roadmap.mutate(fixture.otherCwd, {
    action: 'vision',
    expectedRevision: doc.revision,
    text: 'OTHER_PROJECT_MARKER rendre la migration du volant simple.',
  });
}

const LAYOUT_ROADMAP_VISIBLE = {
  version: 3,
  enabled: true,
  root: {
    kind: 'split',
    id: 'main',
    dir: 'row',
    ratio: 0.68,
    first: { kind: 'group', id: 'conversation-group', panels: ['conversation'], active: 'conversation' },
    second: {
      kind: 'group',
      id: 'tools-group',
      panels: ['roadmap', 'session', 'agents', 'files'],
      active: 'roadmap',
    },
  },
};
const LAYOUT_ROADMAP_HIDDEN = {
  version: 3,
  enabled: true,
  root: {
    kind: 'split',
    id: 'main',
    dir: 'row',
    ratio: 0.68,
    first: { kind: 'group', id: 'conversation-group', panels: ['conversation'], active: 'conversation' },
    second: {
      kind: 'group',
      id: 'tools-group',
      panels: ['roadmap', 'session', 'agents', 'files'],
      active: 'session',
    },
  },
};

const instrument = (page, cwd, sessionId, layout) =>
  page.addInitScript(
    ({ cwd, sessionId, layout }) => {
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId }));
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
      window.__rmReqs = [];
      const origFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (!url.includes('/api/roadmap') || url.includes('/session') || url.includes('retry'))
          return origFetch(...args);
        const rec = { url, method: args[1]?.method || 'GET', t0: performance.now(), t1: null, ok: null };
        window.__rmReqs.push(rec);
        try {
          const res = await origFetch(...args);
          rec.t1 = performance.now();
          rec.ok = res.ok;
          return res;
        } catch (e) {
          rec.t1 = performance.now();
          rec.ok = false;
          throw e;
        }
      };
    },
    { cwd, sessionId, layout },
  );

const rmReqs = (page) => page.evaluate(() => window.__rmReqs || []);
const panelText = (page) => page.evaluate(() => document.querySelector('#roadmap-panel')?.textContent || '');
const panelHas = async (page, m) => (await panelText(page)).includes(m);
async function waitMarker(page, marker, boundMs) {
  const t0 = Date.now();
  for (;;) {
    if (await panelHas(page, marker)) return Date.now() - t0;
    if (Date.now() - t0 > boundMs) return null;
    await sleep(120);
  }
}
async function clickSession(page, sessionId, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const done = await page.evaluate((sid) => {
      const direct = document.querySelector(`button[data-navigation-key="session:${sid}"]`);
      if (direct) {
        direct.click();
        return true;
      }
      return false;
    }, sessionId);
    if (done) return true;
    // Expand pagination ("Afficher plus" / "Show more") then retry.
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('#session-list button, #project-list button')];
      const more = els.find((el) => /afficher plus|show more/i.test(el.textContent || ''));
      if (more) more.click();
    });
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(200);
  }
}
async function clickText(page, rootSel, substr, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const found = await page.evaluate(
      ({ rootSel, substr }) => {
        const root = document.querySelector(rootSel) || document;
        const els = [...root.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find((el) => (el.textContent || '').toLowerCase().includes(substr.toLowerCase()));
        if (hit) {
          hit.click();
          return true;
        }
        return false;
      },
      { rootSel, substr },
    );
    if (found) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(150);
  }
}

let browser;
const watchdog = setTimeout(() => {
  console.error('WATCHDOG session-switch exceeded 120s');
  void browser?.close();
  void fixture.close();
  process.exit(2);
}, 120000);
const summary = {};
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });

  // S1: boot with slash/case variant (app boot canonicalizes via samePath; guards boot path).
  // Boot with forward-slash (and lowercased-drive) cwd; server returns backslash canonical.
  // Baseline: successful GET discarded forever -> permanent Loading. Fixed: loads bounded.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    const fwd = String(fixture.cwd).replaceAll('\\', '/');
    await instrument(page, fwd, 'calibration-demo', LAYOUT_ROADMAP_VISIBLE);
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('#roadmap-panel', { timeout: 30000 });
      const loadedMs = await waitMarker(page, 'Rendre la calibration', BOUND_MS);
      const txt = await panelText(page);
      const reqs = await rmReqs(page);
      assert.ok(
        loadedMs !== null,
        `canonical variant must load bounded (reqs=${reqs.length} text=${txt.slice(0, 120)})`,
      );
      assert.ok(reqs.length <= 6, `bounded GETs expected (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.canonical = { loadedMs, reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // S1b: behavioral sidecar repro with REAL server resolve behavior (no mocked roadmap body).
  // Seeds primary canonical session A + secondary same-project session B whose owner cwd
  // is a slash/lowercase variant (as restored sidecars can persist). Boot primary, then
  // activate secondary via a REAL dock tab click. The variant GET succeeds (server returns
  // canonical resolve(project.cwd)) but baseline roadmap.js (routed snapshot, product
  // untouched) discards it via strict !== and sticks on Loading; fixed product loads.
  // Actual helper edge cases run through vm extraction (no copied norm).
  {
    // Platform-valid variant: Windows slash/lowercase; POSIX original case + trailing slash.
    const variant =
      process.platform === 'win32'
        ? String(fixture.cwd).replaceAll('\\', '/').toLowerCase()
        : `${fixture.cwd}/`;
    const docCanon = await fixture.app.roadmap.read(fixture.cwd);
    const docVariant = await fixture.app.roadmap.read(variant);
    assert.equal(docVariant.cwd, docCanon.cwd, 'server returns canonical cwd for variant input');
    assert.equal(docVariant.revision, docCanon.revision, 'same document for variant cwd');

    // Actual product helper via vm source extraction.
    const helperStart = source.indexOf('const isWindowsRoadmapPath');
    const helperEnd = source.indexOf('const ROADMAP_COLOR_NAMES');
    assert.ok(helperStart > 0 && helperEnd > helperStart, 'helper block must exist in roadmap.js');
    const sameFn = vm.runInNewContext(
      `${source.slice(helperStart, helperEnd)}\nsameRoadmapPath;`,
      {},
      { timeout: 2000 },
    );
    assert.equal(typeof sameFn, 'function', 'extracted sameRoadmapPath must be a function');
    assert.ok(sameFn('C:\\Proj', 'C:/proj'), 'Windows slash+case folds');
    assert.ok(sameFn('C:\\Proj\\', 'c:/proj'), 'Windows trailing slash+case folds');
    assert.ok(!sameFn('/tmp/a\\b', '/tmp/a/b'), 'POSIX backslash is not a separator');
    assert.ok(!sameFn('/', ''), 'POSIX root stays distinct from no project');
    assert.ok(!sameFn('/Proj', '/proj'), 'POSIX case stays distinct');
    assert.ok(sameFn(fixture.cwd, variant), 'variant matches canonical');
    assert.ok(!sameFn(fixture.cwd, fixture.otherCwd), 'different projects stay distinct');

    const SIDECAR_LAYOUT = {
      version: 3,
      enabled: true,
      root: {
        kind: 'split',
        id: 'main',
        dir: 'row',
        ratio: 0.68,
        first: {
          kind: 'group',
          id: 'conversation-group',
          panels: ['conversation', 'conv:secondary1'],
          active: 'conversation',
        },
        second: {
          kind: 'group',
          id: 'tools-group',
          panels: ['roadmap', 'session', 'agents', 'files'],
          active: 'roadmap',
        },
      },
    };
    const runSidecarCase = async (useBaseline) => {
      const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e?.message || e)));
      await page.addInitScript(
        ({ cwd, sessionId, layout, variant }) => {
          localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId }));
          localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
          localStorage.setItem(
            'prime-studio.docking.conversations',
            JSON.stringify({
              version: 1,
              activeId: 'conversation',
              entries: [
                {
                  id: 'conversation',
                  kind: 'session',
                  sessionId: 'calibration-demo',
                  projectCwd: cwd,
                  execCwd: cwd,
                  viewRunId: null,
                  nonce: 'sidecarprimary01',
                  gen: null,
                },
                {
                  id: 'conv:secondary1',
                  kind: 'session',
                  sessionId: 'filter-export',
                  projectCwd: variant,
                  execCwd: variant,
                  viewRunId: null,
                  nonce: 'sidecarsecondary01',
                  gen: null,
                },
              ],
            }),
          );
          window.__rmReqs = [];
          const origFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const url = String(args[0]);
            if (!url.includes('/api/roadmap') || url.includes('/session') || url.includes('retry'))
              return origFetch(...args);
            const rec = { url, method: args[1]?.method || 'GET', t0: performance.now(), t1: null, ok: null };
            window.__rmReqs.push(rec);
            try {
              const res = await origFetch(...args);
              rec.t1 = performance.now();
              rec.ok = res.ok;
              return res;
            } catch (e) {
              rec.t1 = performance.now();
              rec.ok = false;
              throw e;
            }
          };
        },
        { cwd: fixture.cwd, sessionId: 'calibration-demo', layout: SIDECAR_LAYOUT, variant },
      );
      if (useBaseline) {
        assert.ok(baselineFile, 'baseline case requires --baseline=<path>');
        const snapshot = baselineFile;
        await page.route('**/public/roadmap.js', async (route) => {
          try {
            await route.fulfill({ path: snapshot, contentType: 'text/javascript' });
          } catch {}
        });
      }
      try {
        await page.goto(fixture.url);
        await page.waitForSelector('#roadmap-panel', { timeout: 30000 });
        assert.ok((await waitMarker(page, 'Rendre la calibration', BOUND_MS)) !== null, 'primary must load');
        await page.waitForSelector('[data-dock-tab="conv:secondary1"]', { timeout: 10000 });
        await page.click('[data-dock-tab="conv:secondary1"]');
        await sleep(1800);
        const txt = await panelText(page);
        const reqs = await rmReqs(page);
        const gets = reqs.filter((r) => (r.method || 'GET') === 'GET');
        const lastOk = gets.length ? gets.at(-1).ok : null;
        assert.deepEqual(errs.slice(0, 3), []);
        return { txt, reqCount: reqs.length, lastGetOk: lastOk };
      } finally {
        await page.close();
      }
    };
    // Fixed product: same steps load with no Loading and bounded requests.
    const fixed = await runSidecarCase(false);
    assert.equal(fixed.lastGetOk, true, `fixed variant GET must succeed (reqs=${fixed.reqCount})`);
    assert.ok(
      !fixed.txt.includes('Chargement'),
      `fixed must not stick Loading (got ${fixed.txt.slice(0, 120)})`,
    );
    assert.ok(fixed.txt.includes('Rendre la calibration'), 'fixed shows current project doc');
    assert.ok(fixed.reqCount <= 8, `bounded GETs (got ${fixed.reqCount})`);
    summary.sidecar = { fixedReqs: fixed.reqCount };
    if (baselineFile) {
      // Opt-in proof only: same repro against the routed baseline snapshot must stick
      // Loading after a successful canonical GET (the reported bug, product untouched).
      const baseline = await runSidecarCase(true);
      assert.equal(baseline.lastGetOk, true, `baseline variant GET must succeed (reqs=${baseline.reqCount})`);
      assert.ok(
        baseline.txt.includes('Chargement'),
        `baseline must stick Loading after canonical GET (got ${baseline.txt.slice(0, 120)})`,
      );
      summary.sidecar.baselineStuck = true;
    } else {
      summary.sidecar.baselineSkipped = true;
    }
  }

  // S2: same-project A->B->A session switch, roadmap stays visible, never stuck.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, fixture.cwd, 'calibration-demo', LAYOUT_ROADMAP_VISIBLE);
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('#roadmap-panel', { timeout: 30000 });
      assert.ok((await waitMarker(page, 'Rendre la calibration', BOUND_MS)) !== null, 'initial load');
      // B: filter-export session (same project)
      assert.ok(await clickSession(page, 'filter-export'), 'must find session B (filter-export)');
      await sleep(900);
      let txt = await panelText(page);
      assert.ok(
        !txt.includes('Chargement'),
        `same-project switch must not stick Loading (got ${txt.slice(0, 120)})`,
      );
      assert.ok(txt.includes('Rendre la calibration'), 'same-project doc kept');
      // A back
      assert.ok(await clickSession(page, 'calibration-demo'), 'must find session A (calibration-demo)');
      await sleep(900);
      txt = await panelText(page);
      assert.ok(!txt.includes('Chargement'), `A->B->A must not stick Loading (got ${txt.slice(0, 120)})`);
      assert.ok(txt.includes('Rendre la calibration'), 'A doc restored');
      const reqs = await rmReqs(page);
      assert.ok(reqs.length <= 12, `bounded GETs (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.sameProject = { reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // S3: different-project A->other->A, no stale docs, bounded.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, fixture.cwd, 'calibration-demo', LAYOUT_ROADMAP_VISIBLE);
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('#roadmap-panel', { timeout: 30000 });
      assert.ok((await waitMarker(page, 'Rendre la calibration', BOUND_MS)) !== null, 'initial load');
      assert.ok(await clickText(page, '#project-list', 'vtrott'), 'must find Vtrott project');
      const tOther = await waitMarker(page, 'OTHER_PROJECT_MARKER', BOUND_MS);
      assert.ok(tOther !== null, 'other project doc must load bounded, no stale');
      assert.ok(!(await panelHas(page, 'Rendre la calibration')), 'no stale cross-project doc');
      // Back to first project via its name (SoundsPerfect dir name)
      const backName = String(fixture.cwd).split(/[\\/]/).pop().slice(0, 6);
      assert.ok(await clickText(page, '#project-list', backName), `must find back project ${backName}`);
      const tBack = await waitMarker(page, 'Rendre la calibration', BOUND_MS);
      assert.ok(tBack !== null, 'back to A must load bounded');
      assert.ok(!(await panelHas(page, 'OTHER_PROJECT_MARKER')), 'no stale other doc after back');
      const reqs = await rmReqs(page);
      assert.ok(reqs.length <= 10, `bounded GETs (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.diffProject = { reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // S4: hidden switch + reopen + in-flight late response recovers bounded.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, fixture.cwd, 'calibration-demo', LAYOUT_ROADMAP_HIDDEN);
    let n = 0;
    await page.route('**/api/roadmap?*', async (route) => {
      if (++n === 1) await sleep(600);
      try {
        await route.continue();
      } catch {}
    });
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('[data-dock-tab="roadmap"]', { timeout: 30000 });
      await page.click('[data-dock-tab="roadmap"]');
      await sleep(150); // GET in flight
      await page.click('[data-dock-tab="session"]'); // hide
      await sleep(80);
      assert.ok(await clickSession(page, 'filter-export'), 'switch while hidden (filter-export)');
      await sleep(300);
      await page.click('[data-dock-tab="roadmap"]'); // reopen
      const loadedMs = await waitMarker(page, 'Rendre la calibration', BOUND_MS);
      assert.ok(loadedMs !== null, 'hidden->switch->reopen must recover bounded');
      const reqs = await rmReqs(page);
      assert.ok(reqs.length >= 2 && reqs.length <= 10, `bounded refetch (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.hidden = { loadedMs, reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // S5: late/error: one 500 then success -> visible error/retry, then loads, never permanent Loading.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, fixture.cwd, 'calibration-demo', LAYOUT_ROADMAP_VISIBLE);
    // Fail every initial GET (like the timeout path) so the error stays observable;
    // release via unroute, then Retry must load. Baseline fails the content assert.
    await page.route('**/api/roadmap?*', async (route) => {
      try {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'boom' }),
        });
      } catch {}
    });
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('#roadmap-panel', { timeout: 30000 });
      // The failed initial GET must surface a visible error + retry with content
      // repainted (not silent permanent Loading). Baseline fails here: status has
      // the error but content still shows Loading.
      let sawError = false;
      let contentDuringError = '';
      for (let i = 0; i < 80; i++) {
        const st = await page.evaluate(
          () => document.querySelector('#roadmap-panel .rm-status')?.textContent || '',
        );
        if (/Réessayer|Retry/.test(st)) {
          sawError = true;
          contentDuringError = await page.evaluate(
            () => document.querySelector('#roadmap-panel .rm-content')?.textContent || '',
          );
          break;
        }
        await sleep(100);
      }
      assert.ok(sawError, 'failed GET must surface a visible error + retry');
      assert.ok(
        !contentDuringError.includes('Chargement'),
        `error content must replace Loading (got ${contentDuringError.slice(0, 120)})`,
      );
      // Release the failure, then an explicit Retry must load bounded.
      await page.unroute('**/api/roadmap?*');
      const retry = page.locator('#roadmap-panel .rm-status').getByRole('button', { name: 'Réessayer' });
      assert.ok(await retry.count(), 'retry button must be present');
      await retry.first().click();
      const loaded = await waitMarker(page, 'Rendre la calibration', BOUND_MS);
      assert.ok(loaded !== null, 'retry after error must load');
      const reqs = await rmReqs(page);
      assert.ok(reqs.length >= 2 && reqs.length <= 10, `bounded (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.error = { loadedMs: loaded, reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // S6: edit draft survives invalidated refetch (preservation).
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, fixture.cwd, 'calibration-demo', LAYOUT_ROADMAP_VISIBLE);
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('#roadmap-panel', { timeout: 30000 });
      assert.ok((await waitMarker(page, 'Rendre la calibration', BOUND_MS)) !== null, 'load before draft');
      const panel = page.locator('#roadmap-panel');
      await panel.getByRole('button', { name: 'Ajouter un plan' }).click();
      const editor = page.locator('.rm-editor');
      await editor.getByLabel('Titre').fill('DRAFT_SESSION_SWITCH');
      await page.evaluate(() => document.querySelector('[data-dock-tab="session"]')?.click());
      await sleep(120);
      await page.evaluate(() => document.querySelector('[data-dock-tab="roadmap"]')?.click());
      await sleep(700);
      assert.ok(await editor.isVisible(), 'draft must survive flip refetch');
      assert.equal(await editor.getByLabel('Titre').inputValue(), 'DRAFT_SESSION_SWITCH');
      await editor.getByRole('button', { name: 'Annuler' }).click();
      assert.deepEqual(errs.slice(0, 3), []);
      summary.draft = { preserved: true };
    } finally {
      await page.close();
    }
  }

  // S7: stale inline POST settles -> new doc painted WHILE pending, controls re-enable.
  // Real inline checkbox mutation (no modal, no evaluate clicks) behind a bounded
  // controlled POST gate: the gate holds the POST, the project switch lands mid-flight
  // via a real row click, the new doc paints while held (pending disables controls),
  // then the gate releases and controls re-enable with the new doc still current.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, fixture.cwd, 'calibration-demo', LAYOUT_ROADMAP_VISIBLE);
    let releasePost = null;
    const postGate = new Promise((resolveGate) => {
      releasePost = resolveGate;
    });
    await page.route('**/api/roadmap*', async (route) => {
      if ((route.request().method() || 'GET').toUpperCase() === 'GET') {
        try {
          await route.continue();
        } catch {}
        return;
      }
      try {
        await postGate;
      } catch {}
      try {
        await route.continue();
      } catch {}
    });
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('#roadmap-panel', { timeout: 30000 });
      assert.ok(
        (await waitMarker(page, 'Rendre la calibration', BOUND_MS)) !== null,
        'load before stale POST',
      );
      const panel = page.locator('#roadmap-panel');
      await panel.getByRole('button', { name: 'Fiabiliser le parcours de mesure', exact: true }).click();
      await panel.getByRole('checkbox', { name: 'Mesurer le canal droit', exact: true }).click();
      // The mutating POST must be held in flight (pending=true on the client).
      let sawPost = false;
      for (let i = 0; i < 50; i++) {
        const rs = await rmReqs(page);
        if (rs.some((r) => (r.method || 'GET').toUpperCase() !== 'GET')) {
          sawPost = true;
          break;
        }
        await sleep(100);
      }
      assert.ok(sawPost, 'inline POST must be in flight behind the gate');
      await page.locator('#session-list button.project-row', { hasText: 'Vtrott' }).click();
      const tOther = await waitMarker(page, 'OTHER_PROJECT_MARKER', BOUND_MS);
      assert.ok(tOther !== null, 'new doc must paint WHILE stale POST still held');
      assert.ok(!(await panelHas(page, 'Rendre la calibration')), 'no stale old doc while held');
      assert.equal(
        await panel.getByRole('button', { name: 'Ajouter un plan' }).count(),
        0,
        'pending disables current controls while POST held',
      );
      releasePost();
      releasePost = null;
      let enabled = false;
      for (let i = 0; i < 80; i++) {
        const count = await panel.getByRole('button', { name: 'Ajouter un plan' }).count();
        if (count > 0) {
          const disabled = await panel.getByRole('button', { name: 'Ajouter un plan' }).first().isDisabled();
          if (!disabled) {
            enabled = true;
            break;
          }
        }
        await sleep(100);
      }
      assert.ok(enabled, 'gate release settles POST and re-enables controls');
      assert.ok(await panelHas(page, 'OTHER_PROJECT_MARKER'), 'new doc stays current after settle');
      const reqs = await rmReqs(page);
      assert.ok(reqs.length <= 12, `bounded (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.stalePost = { reqs: reqs.length };
    } finally {
      try {
        if (releasePost) releasePost();
      } catch {}
      await page.close();
    }
  }

  console.log(JSON.stringify({ ok: true, summary }));
} finally {
  clearTimeout(watchdog);
  try {
    await browser?.close();
  } catch {}
  await fixture.close();
}
