/**
 * Conversation window helper (pure, no DOM).
 * Shared by public/conversation.js windowed mode.
 * Keeps full history accessible in data; only the mounted DOM window is bounded.
 * Browser find (Ctrl+F) covers mounted text only — explicit limitation.
 */
export const WINDOW_DEFAULTS = {
  overscanPx: 1000,
  maxMounted: 80,
  topThreshold: 600,
  estimateHeight: 140,
};

export function buildBlocks(messages, { isEmpty, isTechnical, idOf }) {
  const filtered = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (isEmpty(m)) continue;
    filtered.push({ msg: m, origIndex: i, id: idOf(m, i) });
  }
  const blocks = [];
  let turnStart = -1;
  const flushTurn = (end) => {
    if (turnStart < 0) return;
    const ids = filtered.slice(turnStart, end).map((f) => f.id);
    blocks.push({ key: ids[0], kind: 'turn', start: turnStart, end, ids });
    turnStart = -1;
  };
  for (let i = 0; i < filtered.length; i += 1) {
    const f = filtered[i];
    const m = f.msg;
    if (m.role === 'assistant' || isTechnical(m)) {
      if (turnStart < 0) turnStart = i;
    } else {
      flushTurn(i);
      blocks.push({ key: f.id, kind: 'single', start: i, end: i + 1, ids: [f.id] });
    }
  }
  flushTurn(filtered.length);
  return { filtered, blocks };
}

function estimatesFor(blocks, heights, avgHeight, estimateHeight) {
  const avg = avgHeight || estimateHeight;
  return blocks.map((b) => heights.get(b.key) ?? avg);
}

export function computeWindow(
  blocks,
  { scrollTop, viewportHeight, heights, avgHeight, estimateHeight, overscanPx, maxMounted, pinnedKeys },
) {
  const est = estimatesFor(blocks, heights, avgHeight, estimateHeight);
  const offsets = new Array(blocks.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < blocks.length; i += 1) offsets[i + 1] = offsets[i] + est[i];
  const total = offsets[blocks.length] || 0;
  const viewTop = Math.max(0, scrollTop - overscanPx);
  const viewBottom = scrollTop + viewportHeight + overscanPx;
  let start = blocks.length;
  let end = blocks.length;
  for (let i = 0; i < blocks.length; i += 1) {
    if (offsets[i + 1] > viewTop && start === blocks.length) start = i;
    if (offsets[i] < viewBottom) end = i + 1;
  }
  if (start === blocks.length) {
    // Empty viewport (e.g. zero heights): fall back to tail.
    start = Math.max(0, blocks.length - Math.min(blocks.length, maxMounted));
    end = blocks.length;
  }
  if (pinnedKeys && pinnedKeys.size) {
    for (let i = 0; i < blocks.length; i += 1) {
      if (pinnedKeys.has(blocks[i].key)) {
        if (i < start) start = i;
        if (i + 1 > end) end = i + 1;
      }
    }
  }
  if (end - start > maxMounted) {
    // Trim farthest from the viewport centre, keep the visible slice plus
    // nearest overscan until the cap is hit.
    const visibleTop = scrollTop;
    const visibleBottom = scrollTop + viewportHeight;
    let visStart = start;
    let visEnd = end;
    for (let i = start; i < end; i += 1) {
      if (offsets[i + 1] > visibleTop) {
        visStart = i;
        break;
      }
    }
    for (let i = start; i < end; i += 1) {
      if (offsets[i] < visibleBottom) visEnd = i + 1;
    }
    let lo = visStart;
    let hi = visEnd;
    if (hi - lo > maxMounted) {
      // Visible slice itself exceeds the cap (many small blocks): keep a
      // centered maxMounted window around the viewport centre.
      const center = Math.floor((visStart + visEnd) / 2);
      lo = Math.max(start, center - Math.floor(maxMounted / 2));
      hi = lo + maxMounted;
      if (hi > end) {
        hi = end;
        lo = Math.max(start, hi - maxMounted);
      }
    } else {
      while (hi - lo < maxMounted && (lo > start || hi < end)) {
        if (lo > start) lo -= 1;
        if (hi - lo >= maxMounted) break;
        if (hi < end) hi += 1;
      }
    }
    start = lo;
    end = hi;
    // Pinned focus/selection blocks were already expanded before the cap;
    // the cap keeps near-viewport pins (practical) and may drop far pins to
    // stay bounded. Far focus loss is acceptable; reading position is kept.
  }
  const topHeight = offsets[start] || 0;
  const bottomHeight = total - (offsets[end] || 0);
  return { start, end, topHeight, bottomHeight, total };
}

export function tailWindow(blocks, maxMounted) {
  const start = Math.max(0, blocks.length - maxMounted);
  return { start, end: blocks.length };
}

export function shouldAutoLoad({ scrollTop, prevScrollTop, hasOlder, loadingOlder, inFlight, topThreshold }) {
  if (!hasOlder || loadingOlder || inFlight) return false;
  if (prevScrollTop == null) return false;
  if (scrollTop >= topThreshold) return false;
  // Intentional upward move near the top only; initial bottom display never fires.
  return scrollTop < prevScrollTop;
}
