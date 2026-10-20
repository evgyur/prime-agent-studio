// Studio-only, best-effort metadata. Never serialize event payloads or tool arguments.
import { appendFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const label = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const stops = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);

export function metricsUsage(usage) {
  return {
    input: number(usage?.input),
    output: number(usage?.output),
    cacheRead: number(usage?.cacheRead),
    cacheWrite: number(usage?.cacheWrite),
    cost:
      typeof usage?.cost?.total === 'number' && Number.isFinite(usage.cost.total) && usage.cost.total >= 0
        ? usage.cost.total
        : null,
  };
}

export function rateLimitHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    // Explicit suffixes, not arbitrary prefix matching: ids/auth-like custom headers stay out.
    if (
      !/^(?:retry-after|(?:x-ratelimit|anthropic-ratelimit|openai-ratelimit)-(?:limit|remaining|reset)(?:-(?:requests|tokens|input-tokens|output-tokens|tokens-usage|requests-usage))?|anthropic-ratelimit-(?:requests|tokens|input-tokens|output-tokens)-(?:limit|remaining|reset))$/.test(
        key,
      )
    )
      continue;
    const text = String(value).slice(0, 100);
    // Quotas, durations and HTTP/ISO dates only; arbitrary header text is not telemetry.
    if (/^[\d. :,+\-TZhmsd]+$/.test(text) || /^\w{3}, \d{2} \w{3} \d{4} [\d:]+ GMT$/.test(text))
      result[key] = text;
  }
  return result;
}

// Usefulness signals for the local code tools. Content-free: only counts and
// booleans reach the ledger. Returned paths live as hashes in process memory
// and are never persisted.
const codeToolName = (toolName) => ({
  studio_code_search: 'search',
  studio_code_symbols: 'symbols',
  studio_code_map: 'map',
})[toolName] || null;
const USEFUL_WINDOW = 5;
const FALLBACK_WINDOW = 3;
const pathHash = (path) => createHash('sha256').update(path).digest('hex');
function codeCounts(result) {
  let rows = null;
  if (Array.isArray(result?.results)) rows = result.results;
  else if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (typeof part?.text !== 'string') continue;
      try {
        const parsed = JSON.parse(part.text);
        if (Array.isArray(parsed?.results)) { rows = parsed.results; break; }
      } catch { /* Non-JSON tool text carries no result rows. */ }
    }
  }
  if (!rows) return { hits: 0, files: 0, chars: 0, paths: [] };
  const paths = new Set();
  let chars = 0;
  for (const row of rows.slice(0, 50)) {
    if (typeof row?.path === 'string' && row.path.length <= 500) paths.add(row.path);
    for (const value of [row?.text, row?.snippet]) {
      if (typeof value === 'string') chars += Math.min(value.length, 5000);
    }
  }
  return { hits: Math.min(rows.length, 1000), files: paths.size, chars, paths: [...paths].slice(0, 20) };
}
function argStrings(args, budget = { count: 0 }) {
  const out = [];
  const visit = (value) => {
    if (budget.count >= 50) return;
    if (typeof value === 'string') {
      budget.count++;
      if (value.length <= 500) out.push(value);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(args);
  return out;
}
const toolTokens = (toolName) => typeof toolName === 'string' ? toolName.toLowerCase().split(/[^a-z]+/).filter(Boolean) : [];
// Token match so 'credit' never counts as an edit and 'dispatch' never counts as a patch,
// while snake_case names such as edit_file still match.
const editToolName = (toolName) => toolTokens(toolName).some((token) => ['edit', 'write', 'apply', 'patch'].includes(token));
const shellToolName = (toolName) => toolTokens(toolName).some((token) => ['shell', 'exec', 'bash', 'terminal', 'command', 'powershell'].includes(token));
const fallbackText = (text) => /\bgrep\b|\brg\b|\bfindstr\b|Select-String/.test(text);

export default function studioMetrics(pi) {
  const directory = process.env.PRIME_STUDIO_METRICS_DIR;
  if (!directory) return;
  let pending = Promise.resolve();
  let queued = 0;
  let sequence = 0;
  const instance = randomUUID();
  const ready = mkdir(directory, { recursive: true }).catch(() => {});
  const append = (type, fields, ctx) => {
    try {
      if (queued >= 512) return; // Slow/full disk must not grow the agent heap.
      if (!fields) return;
      const header = ctx.sessionManager.getHeader?.();
      const sessionId = label(ctx.sessionManager.getSessionId());
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
      const ts = Date.now();
      const entry = {
        id: `${sessionId}:${instance}:${++sequence}`,
        type,
        ts,
        sessionId,
        parentSession: header?.parentSession ? basename(header.parentSession.replaceAll('\\', '/')) : null,
        depth: number(header?.rlmDepth),
        cwd: label(ctx.cwd, 2048),
        provider: label(ctx.model?.provider),
        model: label(ctx.model?.id),
        ...fields,
      };
      const line = JSON.stringify(entry) + '\n';
      queued++;
      pending = pending
        .then(async () => {
          await ready;
          await appendFile(join(directory, `${new Date(ts).toISOString().slice(0, 10)}--${sessionId}-${process.pid}.jsonl`), line, { mode: 0o600 });
        })
        .catch(() => {})
        .finally(() => {
          queued--;
        });
    } catch {
      /* Metrics cannot affect execution. */
    }
  };
  const register = (type, select = () => ({})) => {
    pi.on(type, (event, ctx) => append(type, select(event, ctx), ctx));
  };
  register('after_provider_response', (event) => ({
    status: number(event.status),
    headers: rateLimitHeaders(event.headers),
  }));
  register('message_end', ({ message }) =>
    message?.role === 'assistant'
      ? {
          messageTs: number(message.timestamp),
          provider: label(message.provider),
          model: label(message.model),
          usage: metricsUsage(message.usage),
          stopReason: stops.has(message.stopReason) ? message.stopReason : null,
        }
      : null,
  );
  register('turn_end');
  const summary = (entry) => ({
    entryId: label(entry?.id),
    entryTs: Date.parse(entry?.timestamp) || null,
    // Compaction can use an auxiliary model; the entry does not identify it.
    provider: '',
    model: '',
    ...(entry?.usage ? { usage: metricsUsage(entry.usage) } : {}),
  });
  register('session_compact', (event) => summary(event.compactionEntry));
  register('session_tree', (event) =>
    event.summaryEntry ? { type: 'branch_summary', ...summary(event.summaryEntry) } : null,
  );
  // Pending code lookups per session, resolved within a few tool calls or at shutdown.
  const signals = new Map();
  const resolveSignal = (sessionId, entry) => {
    append('tool_execution_end', {
      toolCalls: 1,
      failed: entry.failed,
      tool: entry.tool,
      hits: entry.hits,
      files: entry.files,
      chars: entry.chars,
      useful: entry.useful,
      fallback: entry.fallback,
      callsToEdit: entry.callsToEdit,
    }, entry.ctx);
    const pending = signals.get(sessionId) || [];
    signals.set(sessionId, pending.filter((item) => item !== entry));
  };
  pi.on('tool_execution_end', (event, ctx) => {
    const sessionId = label(ctx.sessionManager.getSessionId());
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
    const tool = codeToolName(event?.toolName);
    if (!tool) {
      append('tool_execution_end', { toolCalls: 1, failed: event.isError === true }, ctx);
    }
    const pending = signals.get(sessionId) || [];
    if (pending.length && event) {
      const strings = argStrings(event.args);
      for (const entry of [...pending]) {
        entry.calls++;
        const matched = strings.some((text) => entry.paths.has(pathHash(text)));
        if (matched) entry.useful = true;
        else if (entry.calls <= FALLBACK_WINDOW && (event.toolName === 'read_text' || (shellToolName(event.toolName) && strings.some(fallbackText)))) entry.fallback = true;
        if (entry.callsToEdit === null && editToolName(event.toolName)) entry.callsToEdit = entry.calls;
        if (entry.calls >= USEFUL_WINDOW || (entry.calls >= FALLBACK_WINDOW && entry.useful && entry.fallback && entry.callsToEdit !== null)) {
          resolveSignal(sessionId, entry);
        }
      }
    }
    if (tool) {
      const { hits, files, chars, paths } = codeCounts(event?.result);
      const next = (signals.get(sessionId) || []);
      next.push({
        tool, hits, files, chars,
        failed: event.isError === true,
        calls: 0, useful: false, fallback: false, callsToEdit: null,
        paths: new Set(paths.map(pathHash)),
        ctx: {
          sessionManager: { getSessionId: () => sessionId, getHeader: () => ctx.sessionManager.getHeader?.() },
          cwd: ctx.cwd,
          model: ctx.model ? { ...ctx.model } : undefined,
        },
      });
      // Bounded memory: resolve the oldest lookup when too many stay open.
      if (next.length > 25) resolveSignal(sessionId, next[0]);
      signals.set(sessionId, next);
    }
  });
  // No hot-path await. Shutdown is the only place we flush queued writes.
  pi.on('session_shutdown', (event, ctx) => {
    try {
      const sessionId = label(ctx?.sessionManager?.getSessionId());
      if (/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        for (const entry of [...(signals.get(sessionId) || [])]) resolveSignal(sessionId, entry);
        signals.delete(sessionId);
      }
    } catch { /* Metrics cannot affect execution. */ }
    return pending.catch(() => {});
  });
}
