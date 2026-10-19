// Studio-only, best-effort metadata. Never serialize event payloads or tool arguments.
import { appendFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

export default function studioMetrics(pi) {
  const directory = process.env.PRIME_STUDIO_METRICS_DIR;
  if (!directory) return;
  let pending = Promise.resolve();
  let queued = 0;
  let sequence = 0;
  const instance = randomUUID();
  const ready = mkdir(directory, { recursive: true }).catch(() => {});
  const register = (type, select = () => ({})) => {
    pi.on(type, (event, ctx) => {
      try {
        if (queued >= 512) return; // Slow/full disk must not grow the agent heap.
        const fields = select(event, ctx);
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
    });
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
  register('tool_execution_end', (event) => ({ toolCalls: 1, failed: event.isError === true }));
  // No hot-path await. Shutdown is the only place we flush queued writes.
  pi.on('session_shutdown', () => pending.catch(() => {}));
}
