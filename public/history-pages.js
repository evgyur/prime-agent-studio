// UI history pages are snapshots, not engine context. Saved/native history stays complete.
export const HISTORY_PAGE_SIZE = 80;

export function historyPageUrl(id, before = null) {
  const query = new URLSearchParams({ id, limit: String(HISTORY_PAGE_SIZE) });
  if (before) query.set('before', before);
  return `/api/history?${query}`;
}

export function prependHistoryPage(current, older) {
  const present = new Set((current.messages || []).map((m) => m.id));
  const prefix = (older.messages || []).filter((m) => !present.has(m.id));
  return {
    ...current,
    messages: [...prefix, ...(current.messages || [])],
    historyPage: {
      ...current.historyPage,
      start: older.historyPage?.start ?? 0,
      hasBefore: older.historyPage?.hasBefore === true,
      beforeCursor: older.historyPage?.beforeCursor || null,
    },
  };
}

// Normally one request. A detached reader keeps the loaded range, refreshed from
// the source (not a stale cached prefix). This also fills gaps after reconnecting.
// ponytail: refreshing a deeply visited range fetches all pages back to its first
// loaded id; an indexed range endpoint is only needed if that becomes a bottleneck.
export async function fetchRecentHistory(
  api,
  id,
  previous = null,
  { preserveReading = false, isCurrent = () => true } = {},
) {
  const readPage = async (before = null) => {
    const page = await api(historyPageUrl(id, before));
    if (!isCurrent()) throw new DOMException('History binding changed', 'AbortError');
    return page;
  };
  let fresh = await readPage();
  const firstId = previous?.messages?.[0]?.id;
  if (!preserveReading || !firstId) return fresh;
  const seen = new Set();
  while (fresh.historyPage?.hasBefore && !fresh.messages.some((m) => m.id === firstId)) {
    const cursor = fresh.historyPage.beforeCursor;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
    let older;
    try {
      older = await readPage(cursor);
    } catch (error) {
      // A replaced source invalidates the old boundary. Never splice stale data
      // into a different history generation; restart from its newest page.
      if (error?.status === 409) return readPage();
      throw error;
    }
    fresh = prependHistoryPage(fresh, older);
  }
  const first = fresh.messages.findIndex((m) => m.id === firstId);
  if (first > 0 && previous.historyPage?.beforeCursor) {
    fresh = {
      ...fresh,
      messages: fresh.messages.slice(first),
      historyPage: {
        ...fresh.historyPage,
        start: fresh.historyPage.start + first,
        hasBefore: true,
        beforeCursor: previous.historyPage.beforeCursor,
      },
    };
  }
  return fresh;
}
