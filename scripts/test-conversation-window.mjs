// Isolated browser verification for bounded transcript windowing.
// No Studio server, no commit, no install, no active Studio/Lab/models.
// Serves this repo statically on 127.0.0.1 and drives test/fixtures/conversation-window.html with Playwright.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const ROOT = resolve(new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

function startStatic() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/test/fixtures/conversation-window.html';
      const file = join(ROOT, path.replaceAll('/', '/').replace(/^\\/, ''));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('missing');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
    throw e;
  }
};

const server = await startStatic();
const port = server.address().port;
const browser = await launchStudioBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  await page.goto(`http://127.0.0.1:${port}/test/fixtures/conversation-window.html`);
  await page.waitForFunction(() => Boolean(window.__cwTest), null, { timeout: 15000 });

  // 1. Default non-window mode unchanged: all nodes mounted, no spacers/topbar.
  await page.evaluate(() => {
    window.__rLegacy = window.__cwTest.createLegacyRenderer();
    const msgs = window.__cwTest.genAlternating(20, 'leg');
    window.__rLegacy.render(document.getElementById('messages-legacy'), msgs);
  });
  check('legacy default mounts all + no window chrome', () => {});
  const legacyInfo = await page.evaluate(() => {
    const root = document.getElementById('messages-legacy');
    return {
      children: root.children.length,
      hasTopbar: Boolean(root.querySelector('.conv-window-topbar')),
      hasSpacer: Boolean(root.querySelector('.conv-window-top-spacer')),
      assistantTurns: root.querySelectorAll('.assistant-turn').length,
      userMsgs: root.querySelectorAll('.message').length,
    };
  });
  assert.equal(legacyInfo.hasTopbar, false, 'legacy has no topbar');
  assert.equal(legacyInfo.hasSpacer, false, 'legacy has no spacers');
  assert.ok(legacyInfo.children >= 15, `legacy mounts all (${legacyInfo.children})`);
  assert.ok(legacyInfo.assistantTurns >= 5, 'legacy grouping intact');
  results.push(`PASS legacy default mounts all (${legacyInfo.children} children)`);

  // 2. Windowed 1000+ bounded at bottom (tail).
  await page.evaluate(() => {
    window.__r1 = window.__cwTest.createRenderer(true);
    window.__msgs1000 = window.__cwTest.genAlternating(1200, 'w');
    window.__info1 = window.__r1.render(document.getElementById('messages1'), window.__msgs1000, {
      key: 'owner1:session1',
    });
  });
  await sleep(300);
  const win1 = await page.evaluate(() => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    return {
      info: window.__info1,
      mounted: root.querySelectorAll('.assistant-turn, .message').length,
      children: root.children.length,
      topH: document.querySelector('#messages1 .conv-window-top-spacer')?.style.height,
      botH: document.querySelector('#messages1 .conv-window-bottom-spacer')?.style.height,
      atBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      scrollH: scroll.scrollHeight,
      clientH: scroll.clientHeight,
    };
  });
  assert.ok(win1.mounted <= 70, `bounded DOM at bottom (${win1.mounted} mounted for 1200 msgs)`);
  assert.ok(
    (win1.info && win1.info.total === 1200 - 0) || win1.info.total > 900,
    `info.total reflects blocks (${win1.info?.total})`,
  );
  assert.ok(win1.atBottom < 5, `bottom follow lands at bottom (gap ${win1.atBottom})`);
  assert.ok(win1.scrollH > win1.clientH, 'spacers keep scrollHeight truthful');
  results.push(`PASS 1000+ bounded at bottom (${win1.mounted} mounted, gap ${Math.round(win1.atBottom)})`);

  // 3. Top / middle / end windows move with scroll (rAF follow, no stream).
  await page.evaluate(() => document.getElementById('scroll1').scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(400);
  const topWin = await page.evaluate(() => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    const first =
      root.querySelector('.assistant-turn, .message')?.dataset?.messageId ||
      root.querySelector('[data-message-id]')?.dataset?.messageId;
    return {
      top: scroll.scrollTop,
      mounted: root.querySelectorAll('.assistant-turn, .message').length,
      first,
    };
  });
  assert.equal(topWin.top, 0, 'scrolled to top');
  assert.ok(topWin.mounted <= 70, `bounded at top (${topWin.mounted})`);
  assert.ok(
    topWin.first &&
      (topWin.first.startsWith('w0') || topWin.first.startsWith('w1') || topWin.first.startsWith('w2')),
    `top window shows head (${topWin.first})`,
  );
  results.push(`PASS top window head (${topWin.first}, ${topWin.mounted} mounted)`);

  const midTop = await page.evaluate(() => {
    const scroll = document.getElementById('scroll1');
    scroll.scrollTop = Math.floor(scroll.scrollHeight / 2);
    return scroll.scrollTop;
  });
  await sleep(400);
  const midWin = await page.evaluate(() => {
    const root = document.getElementById('messages1');
    return {
      mounted: root.querySelectorAll('.assistant-turn, .message').length,
      start: window.__r1 ? undefined : undefined,
    };
  });
  assert.ok(midWin.mounted <= 70, `bounded in middle (${midWin.mounted})`);
  results.push(`PASS middle bounded (${midWin.mounted})`);

  await page.evaluate(() => {
    const scroll = document.getElementById('scroll1');
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'instant' });
  });
  await sleep(400);
  const endWin = await page.evaluate(() => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    const ids = [...root.querySelectorAll('[data-message-id]')].map((n) => n.dataset.messageId);
    return {
      mounted: root.querySelectorAll('.assistant-turn, .message').length,
      last: ids[ids.length - 1],
      gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
    };
  });
  assert.ok(endWin.last && endWin.last.startsWith('w119'), `end window shows tail (${endWin.last})`);
  assert.ok(endWin.gap < 5, 'back at bottom');
  results.push(`PASS end window tail (${endWin.last})`);

  // 4. Prepend anchor <3px viewport offset (root acceptance shape + async RO/rAF settling).
  const prependRes = await page.evaluate(async () => {
    const scroll = document.getElementById('scroll1');
    const root = document.getElementById('messages1');
    const r = window.__r1;
    const tail80 = window.__cwTest.genUniformSingles(80, 'p');
    window.__prependFull = [...window.__cwTest.genUniformSingles(80, 'q'), ...tail80];
    r.render(root, tail80, { key: 'owner1:prepend', reset: true, follow: true });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    scroll.scrollTop = scroll.scrollHeight;
    await new Promise((res) => setTimeout(res, 150));
    scroll.scrollTop = Math.max(0, scroll.scrollHeight - 900);
    await new Promise((res) => setTimeout(res, 350));
    const box = scroll.getBoundingClientRect();
    const vis = [
      ...root.querySelectorAll('.messages > .message, #messages1 > .message, #messages1 > .assistant-turn'),
    ];
    // First visible direct-child block (root-test shape).
    const node = [...scroll.querySelectorAll('.messages > .message')].find(
      (n) => n.getBoundingClientRect().bottom > box.top + 10 && n.getBoundingClientRect().top < box.bottom,
    );
    const before = node
      ? {
          id: node.dataset.messageId,
          top: node.getBoundingClientRect().top - box.top,
          scroll: scroll.scrollTop,
        }
      : null;
    const info = r.render(root, window.__prependFull, { key: 'owner1:prepend', follow: false });
    await new Promise((res) => setTimeout(res, 200));
    const find = (id) =>
      [...scroll.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === id);
    const n1 = before ? find(before.id) : null;
    const after = n1 ? n1.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    // Async scroll/RO settling: wait for rAF + ResizeObserver frames, re-measure.
    await new Promise((res) => setTimeout(res, 500));
    const n2 = before ? find(before.id) : null;
    const settled = n2 ? n2.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    return { before, after, settled, anchorPreserved: info.anchorPreserved, mounted: n1 ? true : false };
  });
  assert.ok(prependRes.before?.id, 'prepend anchor visible before');
  assert.ok(prependRes.mounted, `prepend anchor still mounted (${prependRes.before.id})`);
  assert.equal(prependRes.anchorPreserved, true, 'prepend returns anchorPreserved true');
  assert.ok(
    prependRes.after !== null && Math.abs(prependRes.after - prependRes.before.top) < 3,
    `prepend viewport offset <3px (before ${Math.round(prependRes.before.top)} after ${Math.round(prependRes.after)})`,
  );
  assert.ok(
    prependRes.settled !== null && Math.abs(prependRes.settled - prependRes.before.top) < 3,
    `prepend settled offset <3px after RO/rAF (${Math.round(prependRes.settled)})`,
  );
  results.push(
    `PASS prepend anchor <3px (${prependRes.before.id} ${Math.round(prependRes.before.top)}->${Math.round(prependRes.after)}/${Math.round(prependRes.settled)})`,
  );

  // 4b. Prepend merging assistant turn above a stable anchor (<3px).
  const mergeRes = await page.evaluate(async () => {
    const scroll = document.getElementById('scroll1');
    const root = document.getElementById('messages1');
    const r = window.__r1;
    // Small total (all mounted, topSpacer 0, no estimates): old tail starts
    // with an assistant turn, prepended part ends with a technical event so
    // the boundary merges into one turn. Anchor is the stable user single
    // BELOW the merge. Uniform bodies keep heights stable; closed activity
    // summaries are measured real (all mounted).
    const uniformBody = (tag) => `Uniform merge body ${tag} ` + 'Lorem ipsum dolor sit amet. '.repeat(4);
    const oldTail = [
      {
        id: 'mg-a0',
        role: 'assistant',
        thinking: uniformBody('A0'),
        tools: [{ id: 'mg-t0', name: 'ipython', status: 'done', args: { code: 'a' }, result: 'ok' }],
        stopReason: 'stop',
      },
      { id: 'mg-u1', role: 'user', text: uniformBody('U1-anchor') },
      ...window.__cwTest.genUniformSingles(8, 'mg-rest'),
    ];
    const prependHead = [
      ...window.__cwTest.genUniformSingles(8, 'mg-pre'),
      { id: 'mg-s-last', role: 'system', customType: 'agent_message', text: uniformBody('S-last') },
    ];
    const full = [...prependHead, ...oldTail];
    r.render(root, oldTail, { key: 'owner1:merge', reset: true, follow: true });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // Park the stable anchor near the top: old head is small so scroll to top.
    scroll.scrollTop = 0;
    await new Promise((res) => setTimeout(res, 350));
    const box = scroll.getBoundingClientRect();
    const beforeNode = [...scroll.querySelectorAll('[data-message-id]')].find(
      (n) => n.dataset.messageId === 'mg-u1',
    );
    const before = beforeNode ? { id: 'mg-u1', top: beforeNode.getBoundingClientRect().top - box.top } : null;
    const info = r.render(root, full, { key: 'owner1:merge', follow: false });
    await new Promise((res) => setTimeout(res, 200));
    const n1 = [...scroll.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === 'mg-u1');
    const after = n1 ? n1.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    await new Promise((res) => setTimeout(res, 500));
    const n2 = [...scroll.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === 'mg-u1');
    const settled = n2 ? n2.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    return { before, after, settled, anchorPreserved: info.anchorPreserved };
  });
  assert.ok(mergeRes.before, 'merge anchor visible before');
  assert.ok(
    mergeRes.after !== null && Math.abs(mergeRes.after - mergeRes.before.top) < 3,
    `merge viewport offset <3px (${Math.round(mergeRes.before.top)}->${Math.round(mergeRes.after)})`,
  );
  assert.ok(
    mergeRes.settled !== null && Math.abs(mergeRes.settled - mergeRes.before.top) < 3,
    `merge settled <3px (${Math.round(mergeRes.settled)})`,
  );
  results.push(
    `PASS prepend-merge anchor <3px (mg-u1 ${Math.round(mergeRes.before.top)}->${Math.round(mergeRes.after)}/${Math.round(mergeRes.settled)})`,
  );

  // 4c. Giant EXPANDED turn interior anchor on same-turn prepend merge (<3px).
  // Same block count before/after (merge, not new blocks): block-top alone would
  // miss interior growth inside the turn. Anchors the topmost visible interior step.
  const giantMergeRes = await page.evaluate(async () => {
    const scroll = document.getElementById('scroll1');
    const root = document.getElementById('messages1');
    const r = window.__r1;
    const mkEvent = (id) => ({
      id,
      role: 'system',
      customType: 'agent_message',
      text: `Uniform expanded event ${id} ` + 'detail word '.repeat(6),
    });
    const oldEvents = [];
    for (let i = 0; i < 200; i += 1) oldEvents.push(mkEvent(`ge${String(i).padStart(4, '0')}`));
    const oldMsgs = [...oldEvents, { id: 'ge-user-tail', role: 'user', text: 'tail after giant' }];
    // Key that starts with the giant turn at head (no leading user) so a
    // technical prepend merges into the SAME first turn: block count unchanged.
    r.render(root, oldMsgs, { key: 'owner1:giant-merge', reset: true, follow: true });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // Open the giant activity (closed by default via lazy): build all steps.
    let stack = root.querySelector('.activity-stack');
    if (stack) {
      // Scroll the giant into view first so layout settles, then open.
      scroll.scrollTop = 200;
      await new Promise((res) => setTimeout(res, 300));
      stack = root.querySelector('.activity-stack');
      if (stack && !stack.open) {
        stack.open = true;
        stack.dispatchEvent(new Event('toggle'));
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    // Scroll to the middle interior (not block top): pick a middle step anchor.
    const sRect0 = scroll.getBoundingClientRect();
    const steps0 = [
      ...root.querySelectorAll(
        '.activity-step[data-message-id], .activity-content > .message[data-message-id]',
      ),
    ];
    const mid = steps0[Math.floor(steps0.length / 2)];
    if (mid) {
      const mr = mid.getBoundingClientRect();
      scroll.scrollTop += mr.top - sRect0.top - 100;
      await new Promise((res) => setTimeout(res, 350));
    }
    const box = scroll.getBoundingClientRect();
    const vis0 = [...root.querySelectorAll('[data-message-id]')]
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter((x) => x.r.bottom > box.top + 1 && x.r.top < box.bottom - 1);
    const leaves0 = vis0.filter((v) => !vis0.some((w) => w.n !== v.n && v.n.contains(w.n)));
    const best0 = leaves0[0] || vis0[0];
    const before = best0 ? { id: best0.n.dataset.messageId, top: best0.r.top - box.top } : null;
    // Prepend 50 technical events merging into the SAME first turn (no new
    // blocks above: same block count, earlier first id, expanded interior).
    const preEvents = [];
    for (let i = 0; i < 50; i += 1) preEvents.push(mkEvent(`gh${String(i).padStart(4, '0')}`));
    const full = [...preEvents, ...oldMsgs];
    const info = r.render(root, full, { key: 'owner1:giant-merge', follow: false });
    await new Promise((res) => setTimeout(res, 250));
    const findById = (id) => {
      const cands = [...root.querySelectorAll(`[data-message-id="${id}"]`)].filter((n) => n.isConnected);
      for (let ci = cands.length - 1; ci >= 0; ci -= 1) {
        const rr = cands[ci].getBoundingClientRect();
        const ss = scroll.getBoundingClientRect();
        if (rr.bottom > ss.top - 4000 && rr.top < ss.bottom + 4000) return cands[ci];
      }
      return cands[0] || null;
    };
    const n1 = before ? findById(before.id) : null;
    const after = n1 ? n1.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    await new Promise((res) => setTimeout(res, 500));
    const n2 = before ? findById(before.id) : null;
    const settled = n2 ? n2.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    return { before, after, settled, anchorPreserved: info.anchorPreserved };
  });
  assert.ok(giantMergeRes.before?.id, 'giant interior anchor visible before merge');
  assert.ok(
    giantMergeRes.after !== null && Math.abs(giantMergeRes.after - giantMergeRes.before.top) < 3,
    `giant expanded interior offset <3px (${Math.round(giantMergeRes.before.top)}->${Math.round(giantMergeRes.after)})`,
  );
  assert.ok(
    giantMergeRes.settled !== null && Math.abs(giantMergeRes.settled - giantMergeRes.before.top) < 3,
    `giant settled <3px (${Math.round(giantMergeRes.settled)})`,
  );
  results.push(
    `PASS giant expanded interior merge <3px (${giantMergeRes.before.id} ${Math.round(giantMergeRes.before.top)}->${Math.round(giantMergeRes.after)}/${Math.round(giantMergeRes.settled)})`,
  );

  // 5. Live append: at bottom follows; detached preserves reading.
  await page.evaluate(() => {
    const scroll = document.getElementById('scroll1');
    const root = document.getElementById('messages1');
    const r = window.__r1;
    window.__liveBase = [...window.__prependFull];
    r.render(root, window.__liveBase, { key: 'owner1:prepend' });
    scroll.scrollTop = scroll.scrollHeight;
  });
  await sleep(250);
  const liveFollow = await page.evaluate(() => {
    const scroll = document.getElementById('scroll1');
    const root = document.getElementById('messages1');
    const r = window.__r1;
    const next = [
      ...window.__liveBase,
      { id: 'live1', role: 'user', text: 'live user' },
      { id: 'live2', role: 'assistant', text: 'live answer', stopReason: 'stop' },
    ];
    window.__liveBase = next;
    const info = r.render(root, next, { key: 'owner1:prepend' });
    return {
      gapBefore: 0,
      info,
      gapAfter: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      last: root.querySelector('[data-message-id]:last-child')?.dataset?.messageId,
    };
  });
  await sleep(250);
  const liveFollowAfter = await page.evaluate(() => {
    const scroll = document.getElementById('scroll1');
    return { gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight };
  });
  assert.ok(
    liveFollowAfter.gap < 30,
    `live append at bottom follows (gap ${Math.round(liveFollowAfter.gap)})`,
  );
  results.push(`PASS live append follow (gap ${Math.round(liveFollowAfter.gap)})`);

  const detachedPos = await page.evaluate(() => {
    const scroll = document.getElementById('scroll1');
    scroll.scrollTop = Math.max(0, scroll.scrollHeight - 1200);
    return scroll.scrollTop;
  });
  await sleep(300);
  const detachedAfter = await page.evaluate(async () => {
    const scroll = document.getElementById('scroll1');
    const root = document.getElementById('messages1');
    const r = window.__r1;
    const box = scroll.getBoundingClientRect();
    const firstNode = [...scroll.querySelectorAll('.messages > .message')].find(
      (n) => n.getBoundingClientRect().bottom > box.top + 10,
    );
    const before = firstNode
      ? {
          id: firstNode.dataset.messageId,
          top: firstNode.getBoundingClientRect().top - box.top,
          scroll: scroll.scrollTop,
        }
      : null;
    const next = [
      ...window.__liveBase,
      { id: 'live3', role: 'assistant', text: 'background answer', stopReason: 'stop' },
    ];
    window.__liveBase = next;
    const info = r.render(root, next, { key: 'owner1:prepend', follow: false });
    await new Promise((res) => setTimeout(res, 200));
    const n1 = before
      ? [...scroll.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === before.id)
      : null;
    const after = n1 ? n1.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    await new Promise((res) => setTimeout(res, 500));
    const n2 = before
      ? [...scroll.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === before.id)
      : null;
    const settled = n2 ? n2.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
    return { before, after, settled, anchorPreserved: info.anchorPreserved };
  });
  assert.ok(detachedAfter.before?.id, 'detached anchor visible before append');
  assert.ok(
    detachedAfter.after !== null && Math.abs(detachedAfter.after - detachedAfter.before.top) < 3,
    `detached append viewport offset <3px (${Math.round(detachedAfter.before.top)}->${Math.round(detachedAfter.after)})`,
  );
  assert.ok(
    detachedAfter.settled !== null && Math.abs(detachedAfter.settled - detachedAfter.before.top) < 3,
    `detached settled <3px (${Math.round(detachedAfter.settled)})`,
  );
  results.push(
    `PASS detached live append <3px (${detachedAfter.before.id} ${Math.round(detachedAfter.before.top)}->${Math.round(detachedAfter.after)}/${Math.round(detachedAfter.settled)})`,
  );

  // 6. Width resize re-measures, stays bounded.
  await page.evaluate(() => {
    document.getElementById('scroll1').style.width = '420px';
  });
  await sleep(400);
  const resizeWin = await page.evaluate(() => ({
    mounted: document.getElementById('messages1').querySelectorAll('.assistant-turn, .message').length,
    scrollH: document.getElementById('scroll1').scrollHeight,
  }));
  assert.ok(resizeWin.mounted <= 70, `bounded after width resize (${resizeWin.mounted})`);
  assert.ok(resizeWin.scrollH > 500, 'scrollHeight still truthful after resize');
  results.push(`PASS width resize bounded (${resizeWin.mounted})`);
  await page.evaluate(() => {
    document.getElementById('scroll1').style.width = '620px';
  });
  await sleep(300);

  // 7. Disclosure + focus preserved across re-render (practical).
  const disclosureRes = await page.evaluate(() => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    scroll.scrollTop = scroll.scrollHeight;
    const stack = root.querySelector('.activity-stack');
    // Force some technical grouping: our alternating fixture has no activity stacks (all text).
    // Use a dedicated binding with technical messages for this check.
    return { hasStack: Boolean(stack) };
  });
  // Build a binding with activity stacks for disclosure test.
  await page.evaluate(() => {
    const mk = [];
    for (let i = 0; i < 30; i += 1) {
      mk.push({ id: `d-u${i}`, role: 'user', text: `q ${i}` });
      mk.push({
        id: `d-a${i}`,
        role: 'assistant',
        thinking: `reason ${i} `.repeat(6),
        tools: [{ id: `t${i}`, name: 'ipython', status: 'done', args: { code: 'x' }, result: 'ok' }],
        stopReason: 'stop',
      });
      mk.push({ id: `d-s${i}`, role: 'system', customType: 'agent_message', text: `event ${i}` });
    }
    window.__disclosureMsgs = mk;
    window.__r1.render(document.getElementById('messages1'), mk, { key: 'owner1:disclosure', reset: true });
  });
  await sleep(300);
  const disc2 = await page.evaluate(async () => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    scroll.scrollTop = scroll.scrollHeight;
    await new Promise((r) => setTimeout(r, 200));
    const stack = [...root.querySelectorAll('.activity-stack')].pop();
    if (!stack) return { hasStack: false };
    stack.open = true;
    stack.dispatchEvent(new Event('toggle'));
    await new Promise((r) => setTimeout(r, 120));
    const stepsBefore = stack.querySelectorAll('.activity-step').length;
    // Focus a copy button inside the last assistant text if present, else the stack summary.
    const summary = stack.querySelector('summary');
    summary.focus();
    const activeBefore = document.activeElement?.textContent?.slice(0, 20);
    // Re-render same binding with one appended message (live).
    const next = [...window.__disclosureMsgs, { id: 'd-u-end', role: 'user', text: 'last q' }];
    const info = window.__r1.render(root, next, { key: 'owner1:disclosure' });
    await new Promise((r) => setTimeout(r, 150));
    const stackAfter = [...root.querySelectorAll('.activity-stack')].find(
      (s) => s === stack || s.contains(document.activeElement) || true,
    );
    const stillOpen = stack.isConnected
      ? stack.open
      : [...root.querySelectorAll('.activity-stack')].some((s) => s.open);
    return {
      hasStack: true,
      stepsBefore,
      stillOpen,
      activeStillInRoot: root.contains(document.activeElement),
      info,
    };
  });
  assert.ok(disc2.hasStack, 'disclosure fixture has activity stacks');
  assert.ok(disc2.stepsBefore > 0, `opened stack reveals steps (${disc2.stepsBefore})`);
  assert.ok(disc2.stillOpen, 'disclosure open state preserved across re-render');
  results.push(`PASS disclosure/focus (steps ${disc2.stepsBefore}, open preserved)`);

  // 8. Independent instances: two panes scroll independently.
  await page.evaluate(() => {
    window.__r2 = window.__cwTest.createRenderer(true);
    const a = window.__cwTest.genAlternating(400, 'A');
    const b = window.__cwTest.genAlternating(400, 'B');
    window.__r2.render(document.getElementById('messages2'), b, { key: 'owner2:session2', reset: true });
    window.__r1.render(document.getElementById('messages1'), a, { key: 'owner1:indep', reset: true });
  });
  await sleep(300);
  await page.evaluate(() => {
    document.getElementById('scroll1').scrollTop = 0;
    document.getElementById('scroll2').scrollTop = document.getElementById('scroll2').scrollHeight;
  });
  await sleep(400);
  const indep = await page.evaluate(() => {
    const first1 = document.getElementById('messages1').querySelector('[data-message-id]')
      ?.dataset?.messageId;
    const ids2 = [...document.getElementById('messages2').querySelectorAll('[data-message-id]')].map(
      (n) => n.dataset.messageId,
    );
    return {
      first1,
      last2: ids2[ids2.length - 1],
      top1: document.getElementById('scroll1').scrollTop,
      mounted1: document.getElementById('messages1').querySelectorAll('.assistant-turn, .message').length,
      mounted2: document.getElementById('messages2').querySelectorAll('.assistant-turn, .message').length,
    };
  });
  assert.ok(indep.first1 && indep.first1.startsWith('A'), `pane1 independent head (${indep.first1})`);
  assert.ok(indep.last2 && indep.last2.startsWith('B39'), `pane2 independent tail (${indep.last2})`);
  assert.ok(
    indep.mounted1 <= 70 && indep.mounted2 <= 70,
    `both panes bounded (${indep.mounted1}, ${indep.mounted2})`,
  );
  results.push(`PASS independent instances (${indep.first1} / ${indep.last2})`);

  // 9. Load-older affordance + auto-load guard (no eager load on initial display).
  const olderRes = await page.evaluate(async () => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    let calls = 0;
    const loadOlder = () => {
      calls += 1;
      return Promise.resolve();
    };
    const tail = window.__cwTest.genAlternating(40, 'old-tail');
    // Initial bottom display with hasOlder: must NOT auto-call.
    const info = window.__r1.render(root, tail, {
      key: 'owner1:older',
      reset: true,
      hasOlder: true,
      loadOlder,
      loadingOlder: false,
    });
    await new Promise((r) => setTimeout(r, 300));
    const btn = root.querySelector('.conv-window-load-older');
    const callsAfterInitial = calls;
    // Intentional upward scroll near top should auto-call once.
    scroll.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400));
    const callsAfterScroll = calls;
    // Click the button explicitly (retry path).
    btn?.click?.();
    await new Promise((r) => setTimeout(r, 200));
    // Loading + error states.
    window.__r1.render(root, tail, { key: 'owner1:older', hasOlder: true, loadOlder, loadingOlder: true });
    await new Promise((r) => setTimeout(r, 80));
    const loadingShown = Boolean(root.querySelector('.conv-window-loading'));
    window.__r1.render(root, tail, {
      key: 'owner1:older',
      hasOlder: true,
      loadOlder,
      olderError: 'stale boundary, retry',
    });
    await new Promise((r) => setTimeout(r, 80));
    const errorShown = root.textContent.includes('stale boundary');
    const retryBtn = Boolean(root.querySelector('.conv-window-retry'));
    return {
      callsAfterInitial,
      callsAfterScroll,
      callsAfterClick: calls,
      loadingShown,
      errorShown,
      retryBtn,
      hasBtn: Boolean(btn),
    };
  });
  assert.equal(olderRes.callsAfterInitial, 0, 'no eager load on initial bottom display');
  assert.ok(olderRes.hasBtn, 'top load-older affordance exposed');
  assert.ok(olderRes.callsAfterScroll >= 1, 'intentional upward scroll near top auto-loads');
  assert.ok(olderRes.loadingShown, 'loading state shown');
  assert.ok(olderRes.errorShown && olderRes.retryBtn, 'error + retry shown');
  results.push(
    `PASS load-older affordance (initial ${olderRes.callsAfterInitial}, after scroll ${olderRes.callsAfterScroll})`,
  );

  // 10. Giant CLOSED activity stays lightweight; opening reveals all (small-change lazy).
  const giantRes = await page.evaluate(async () => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    const giant = window.__cwTest.genGiantTurn(1000, 'gz');
    const msgs = [
      { id: 'gz-user', role: 'user', text: 'start' },
      ...giant,
      { id: 'gz-end', role: 'assistant', text: 'done', stopReason: 'stop' },
    ];
    window.__r1.render(root, msgs, { key: 'owner1:giant', reset: true });
    await new Promise((r) => setTimeout(r, 250));
    scroll.scrollTop = scroll.scrollHeight;
    await new Promise((r) => setTimeout(r, 250));
    const stack = root.querySelector('.activity-stack');
    const content = stack?.querySelector('.activity-content');
    const stepsClosed = content ? content.childElementCount : -1;
    const countText = stack ? stack.textContent.slice(0, 200) : '';
    let stepsOpen = -1;
    if (stack) {
      stack.open = true;
      stack.dispatchEvent(new Event('toggle'));
      await new Promise((r) => setTimeout(r, 600));
      const c2 = stack.querySelector('.activity-content');
      // System events render as message nodes; assistant tool steps render as .activity-step.
      stepsOpen = c2 ? c2.childElementCount : -1;
    }
    return { stepsClosed, stepsOpen, countText: countText.slice(0, 120) };
  });
  assert.ok(
    giantRes.stepsClosed <= 5,
    `closed giant turn lightweight (${giantRes.stepsClosed} nodes for 1000 events)`,
  );
  assert.ok(giantRes.stepsOpen >= 900, `opening reveals all (${giantRes.stepsOpen} nodes)`);
  results.push(
    `PASS giant closed lightweight (${giantRes.stepsClosed} closed -> ${giantRes.stepsOpen} open)`,
  );

  // 11. Return contract + destroy hook.
  const retRes = await page.evaluate(() => {
    const root = document.getElementById('messages1');
    const r = window.__r1;
    const a = window.__cwTest.genAlternating(50, 'ret');
    const infoFresh = r.render(root, a, { key: 'owner1:ret', reset: true, follow: true });
    const infoSame = r.render(root, a, { key: 'owner1:ret' });
    let destroyOk = true;
    try {
      r.destroy(root);
    } catch {
      destroyOk = false;
    }
    // Re-render after destroy must recreate cleanly.
    const infoAfter = r.render(root, a, { key: 'owner1:ret2', reset: true });
    return { fresh: infoFresh, same: infoSame, destroyOk, after: infoAfter };
  });
  assert.equal(retRes.fresh.anchorPreserved, false, 'fresh-key returns anchorPreserved false');
  assert.ok(typeof retRes.fresh.scrollTop === 'number', 'fresh returns scrollTop');
  assert.ok(typeof retRes.same.scrollTop === 'number', 'same-binding returns scrollTop');
  assert.equal(retRes.destroyOk, true, 'destroy(root) clean');
  assert.ok(retRes.after && typeof retRes.after.start === 'number', 're-render after destroy works');
  results.push(`PASS return + destroy contract`);

  // 12. Fresh-key with follow:false + saved top restores reading (no blind bottom force).
  const savedRes = await page.evaluate(async () => {
    const root = document.getElementById('messages1');
    const scroll = document.getElementById('scroll1');
    const r = window.__r1;
    const big = window.__cwTest.genAlternating(300, 'sv');
    const info = r.render(root, big, { key: 'owner1:saved', reset: true, follow: false, scrollTop: 12000 });
    await new Promise((res) => setTimeout(res, 200));
    return {
      scrollTop: scroll.scrollTop,
      anchor: info.anchorPreserved,
      start: info.start,
      end: info.end,
      total: info.total,
    };
  });
  assert.equal(savedRes.anchor, false, 'saved-top fresh returns anchor false');
  assert.ok(
    Math.abs(savedRes.scrollTop - 12000) < 400,
    `saved top restored near 12000 (got ${Math.round(savedRes.scrollTop)})`,
  );
  assert.ok(
    savedRes.start > 0 && savedRes.end < savedRes.total,
    'saved-top window middle, not forced to tail/head',
  );
  results.push(`PASS fresh-key saved-top restore (${Math.round(savedRes.scrollTop)})`);

  // 12b. Single anchoring owner: windowed scrollers opt out of native
  // overflow-anchor (manual virtualizer owns it); legacy untouched.
  const anchorOwner = await page.evaluate(() => ({
    s1: document.getElementById('scroll1').style.getPropertyValue('overflow-anchor'),
    s2: document.getElementById('scroll2').style.getPropertyValue('overflow-anchor'),
    legacy: document.getElementById('scroll-legacy').style.getPropertyValue('overflow-anchor'),
  }));
  assert.equal(anchorOwner.s1, 'none', 'windowed pane1 manual anchor owner');
  assert.equal(anchorOwner.s2, 'none', 'windowed pane2 manual anchor owner');
  assert.ok(anchorOwner.legacy !== 'none', 'legacy non-windowed native anchoring untouched');
  results.push(`PASS single anchor owner (windowed none, legacy untouched)`);

  // 13. Empty new-conversation geometry: no scaffold padding when truly empty.
  const emptyGeo = await page.evaluate(async () => {
    const root = document.getElementById('messages2');
    const scroll = document.getElementById('scroll2');
    const r = window.__r2 || window.__cwTest.createRenderer(true);
    window.__r2 = r;
    // Truly empty, no older affordance: root must clear children (:empty collapses padding).
    r.render(root, [], { key: 'owner2:empty', reset: true });
    await new Promise((res) => setTimeout(res, 120));
    const cleared = {
      children: root.childElementCount,
      empty: root.matches(':empty'),
      scrollH: scroll.scrollHeight,
      clientH: scroll.clientHeight,
    };
    // Filtered-empty page with hasOlder true: bar must stay (load older).
    const filteredOnly = [{ id: 'e1', role: 'assistant', stopReason: 'stop', text: '   ' }];
    let calls = 0;
    r.render(root, filteredOnly, {
      key: 'owner2:empty',
      hasOlder: true,
      loadOlder: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    await new Promise((res) => setTimeout(res, 120));
    const withBar = {
      children: root.childElementCount,
      hasBtn: Boolean(root.querySelector('.conv-window-load-older')),
      empty: root.matches(':empty'),
    };
    // Non-empty after clear: scaffold reinserts via isConnected path, messages mount.
    const back = window.__cwTest.genUniformSingles(10, 'emback');
    const info = r.render(root, back, { key: 'owner2:empty' });
    await new Promise((res) => setTimeout(res, 200));
    const restored = {
      children: root.childElementCount,
      mounted: root.querySelectorAll('.assistant-turn, .message').length,
      start: info.start,
      total: info.total,
    };
    return { cleared, withBar, restored, calls };
  });
  assert.equal(emptyGeo.cleared.children, 0, 'empty new conversation clears scaffold children');
  assert.equal(emptyGeo.cleared.empty, true, ':empty holds so CSS padding collapses (no 71px blank)');
  assert.ok(
    emptyGeo.withBar.hasBtn && !emptyGeo.withBar.empty,
    'filtered-empty with hasOlder keeps load-older bar',
  );
  assert.ok(
    emptyGeo.restored.mounted >= 8 && emptyGeo.restored.total === 10,
    `scaffold reinserts after clear (${emptyGeo.restored.mounted} mounted)`,
  );
  results.push(
    `PASS empty geometry (cleared ${emptyGeo.cleared.children}, bar kept, restored ${emptyGeo.restored.mounted})`,
  );

  const reveal = await page.evaluate(async () => {
    const root = document.getElementById('messages1'),
      scroll = document.getElementById('scroll1');
    const data = window.__cwTest.genUniformSingles(1000, 'jump');
    const renderer = window.__r1;
    renderer.render(root, data, { key: 'jump-session', reset: true });
    const target = data[120].id;
    const absentBefore = !root.querySelector(`[data-message-id="${target}"]`);
    const node = renderer.reveal(root, target);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return {
      absentBefore,
      id: node?.dataset.messageId,
      target,
      offset: node?.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
      focused: document.activeElement === node,
      mounted: root.querySelectorAll('.message').length,
    };
  });
  assert.ok(reveal.absentBefore, 'jump target starts virtualized out');
  assert.equal(reveal.id, reveal.target);
  assert.ok(reveal.focused);
  assert.ok(
    Math.abs(reveal.offset) < 3,
    `reveal target remains at viewport start: ${JSON.stringify(reveal)}`,
  );
  assert.ok(reveal.mounted <= 60);
  results.push('PASS explicit reveal mounts offscreen target, focuses it, keeps DOM bounded');

  const toolReveal = await page.evaluate(async () => {
    const root = document.getElementById('messages1'),
      scroll = document.getElementById('scroll1');
    const giant = Array.from({ length: 12 }, (_, i) => ({
      id: `jump-tool-${i}`,
      role: 'assistant',
      text: '',
      tools: [
        {
          id: `tool-${i}`,
          name: 'ipython',
          arguments: { code: `print(${i})` },
          result: String(i),
          status: 'completed',
        },
      ],
    }));
    const data = [...giant, ...window.__cwTest.genUniformSingles(200, 'after-tool')];
    const target = giant[7].id;
    const renderer = window.__r1;
    renderer.render(root, data, { key: 'tool-jump-session', reset: true });
    const absentBefore = !root.querySelector(`[data-message-id="${target}"]`);
    const node = renderer.reveal(root, target);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return {
      absentBefore,
      id: node?.dataset.messageId,
      target,
      focused: document.activeElement === node,
      open: !!node?.closest('details[open]'),
      offset: node?.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
    };
  });
  assert.ok(toolReveal.absentBefore);
  assert.equal(toolReveal.id, toolReveal.target);
  assert.ok(toolReveal.focused && toolReveal.open);
  assert.ok(Math.abs(toolReveal.offset) < 3, `lazy tool reveal stays visible: ${JSON.stringify(toolReveal)}`);
  results.push('PASS explicit reveal opens the matching lazy historical tool activity');

  assert.deepEqual(errors, [], `no page errors (${errors.join('; ')})`);
  console.log(results.join('\n'));
  console.log(`ALL CONVERSATION-WINDOW BROWSER CHECKS PASSED (${results.length} checks)`);
} finally {
  await browser.close();
  server.close();
}
