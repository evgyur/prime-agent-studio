// Additive history pagination for private GET /api/history.
// Default (no limit) stays FULL and byte-shape compatible: no historyPage key.
// Opt-in ?limit=N returns the newest N messages (chronological) plus
// historyPage metadata; ?limit=N&before=<cursor> returns the N messages
// strictly before the boundary message. Only messages are paginated: every
// other session field (messageCount, readState, title, model, git, ...) stays
// FULL authoritative. The source history is never mutated or truncated.
// Cursor: opaque base64url(JSON {v:1, sid, mid}) where mid is the id of the
// first message of the issued page. Boundaries resolve by message id (not
// offset) so appends between pages cause no duplication or skips. No signing,
// no infrastructure, no dependency.
import { HttpError } from './store.mjs';

export const HISTORY_PAGE_LIMIT_MIN = 1;
export const HISTORY_PAGE_LIMIT_MAX = 200;
export const HISTORY_PAGE_CURSOR_MAX_LENGTH = 2048;
const HISTORY_PAGE_CURSOR_VERSION = 1;

// Strict digits-only integer in [min, max]; mirrors the public v1 limit style.
export function parseHistoryLimit(raw) {
  if (raw === null) return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw))
    throw new HttpError(400, 'Invalid limit. Send an integer between 1 and 200.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < HISTORY_PAGE_LIMIT_MIN || value > HISTORY_PAGE_LIMIT_MAX)
    throw new HttpError(400, 'Invalid limit. Send an integer between 1 and 200.');
  return value;
}

// Encode the page boundary: session id + first message id of the page.
export function encodeHistoryCursor(sessionId, messageId) {
  const payload = JSON.stringify({ v: HISTORY_PAGE_CURSOR_VERSION, sid: sessionId, mid: messageId });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function malformed() {
  return new HttpError(400, 'Invalid cursor. Fetch the newest page again.');
}

// Decode and validate structure. Session binding is checked by the caller
// (needs the requested id); unknown fields are ignored.
export function decodeHistoryCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > HISTORY_PAGE_CURSOR_MAX_LENGTH)
    throw malformed();
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw malformed();
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw malformed();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw malformed();
  if (parsed.v !== HISTORY_PAGE_CURSOR_VERSION) throw malformed();
  if (typeof parsed.sid !== 'string' || !parsed.sid) throw malformed();
  if (typeof parsed.mid !== 'string' || !parsed.mid) throw malformed();
  return { sid: parsed.sid, mid: parsed.mid };
}

// Pure slice of a FULL history object. Returns { messages, historyPage }.
// Throws 400 (malformed/cross-session cursor) or 409 (stale boundary: the
// anchor message is gone, e.g. replaced history — fetch newest page again).
export function pageHistoryMessages(history, { limit, before }) {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const total = messages.length;
  let end = total;
  if (before !== null && before !== undefined) {
    const { sid, mid } = decodeHistoryCursor(before);
    if (sid !== history?.id)
      throw new HttpError(400, 'Invalid cursor for this conversation. Fetch the newest page again.');
    const boundary = messages.findIndex((m) => m?.id === mid);
    if (boundary < 0) throw new HttpError(409, 'This history changed. Fetch the newest page again.');
    end = boundary;
  }
  const start = Math.max(0, end - limit);
  const page = messages.slice(start, end);
  return {
    messages: page,
    historyPage: {
      total,
      limit,
      start,
      end,
      hasBefore: start > 0,
      beforeCursor: start > 0 ? encodeHistoryCursor(history.id, messages[start].id) : null,
    },
  };
}
