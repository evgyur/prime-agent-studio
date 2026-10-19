import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { metricsUsage, rateLimitHeaders } from '../runtime/studio-metrics-extension.mjs';

const DAY = 86400000;
const MAX_LINE = 16 * 1024 * 1024;
const MAX_RECORDS = 250000;
const MAX_BYTES = 64 * 1024 * 1024;
const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const kinds = new Set([
  'message_end',
  'after_provider_response',
  'turn_end',
  'tool_execution_end',
  'session_compact',
  'branch_summary',
  'run_start',
  'run_end',
]);
const stops = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
const statuses = new Set(['completed', 'failed', 'stopped']);

// Snapshot reads never consume an incomplete last line. Fixed chunks bound memory,
// including corrupt/oversized source lines. No transcript text is retained.
async function* lines(file, offset = 0, end = Infinity, budget = null) {
  const handle = await open(file, 'r');
  let position = offset,
    pending = Buffer.alloc(0),
    skipping = false;
  try {
    const limit = Math.min(end, (await handle.stat()).size, budget ? offset + MAX_BYTES - budget.bytes : Infinity);
    const buffer = Buffer.alloc(64 * 1024);
    while (position < limit) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      if (budget) budget.bytes += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let boundary;
      while ((boundary = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, boundary);
        const next = position - pending.length + boundary + 1;
        pending = pending.subarray(boundary + 1);
        let value = null;
        if (!skipping && line.length <= MAX_LINE) {
          try {
            value = JSON.parse(line.toString('utf8'));
          } catch {}
        }
        skipping = false;
        yield { value, offset: next };
      }
      if (pending.length > MAX_LINE || skipping) {
        pending = Buffer.alloc(0);
        skipping = true;
      }
      await yieldTurn();
    }
  } finally {
    await handle.close();
  }
}

function sanitize(record) {
  if (!kinds.has(record?.type) || number(record.ts) === null || record.ts > 8640000000000000) return null;
  const result = {
    id: text(record.id, 300),
    type: record.type,
    ts: record.ts,
    sessionId: text(record.sessionId),
    parentSession: text(record.parentSession),
    depth: number(record.depth),
    project: text(record.project, 2048),
    provider: text(record.provider),
    model: text(record.model),
  };
  if (!result.id) return null;
  if (
    record.type === 'message_end' ||
    (['session_compact', 'branch_summary'].includes(record.type) && record.usage)
  ) {
    result.messageTs = number(record.messageTs);
    result.usage = metricsUsage(
      record.usage && {
        ...record.usage,
        cost: { total: typeof record.usage.cost === 'number' ? record.usage.cost : record.usage.cost?.total },
      },
    );
    result.stopReason = stops.has(record.stopReason) ? record.stopReason : null;
  }
  if (record.type === 'after_provider_response') {
    result.status = number(record.status);
    result.headers = rateLimitHeaders(record.headers);
  }
  if (record.type === 'run_end') {
    if (number(record.durationMs) !== null) result.durationMs = record.durationMs;
    if (number(record.ttftMs) !== null) result.ttftMs = record.ttftMs;
    result.status = statuses.has(record.status) ? record.status : 'failed';
    result.errorClass = ['4xx', '5xx', 'runtime', 'cancelled'].includes(record.errorClass)
      ? record.errorClass
      : null;
  }
  if (record.type === 'tool_execution_end') {
    result.toolCalls = 1;
    result.failed = record.failed === true;
  }
  return result;
}

export function createMetrics({
  dataDir,
  sessionDir,
  artifactDir,
  resolveProject = async (cwd) => ({ cwd }),
  now = Date.now,
} = {}) {
  const directory = join(dataDir, 'metrics');
  const rawDir = join(directory, 'raw');
  const cursorDir = join(directory, 'cursors');
  let writes = Promise.resolve(),
    background = null,
    closed = false,
    queued = 0;
  let lastScan = 0,
    scanComplete = false,
    scanFailed = false,
    dropped = 0,
    generation = 0,
    maintenance = null;
  let summaryQueue = Promise.resolve();
  const summaries = new Map();
  const timing = new WeakMap();
  const projects = new Map();
  const ready = Promise.all([mkdir(rawDir, { recursive: true }), mkdir(cursorDir, { recursive: true })]);
  ready.catch(() => {});
  const oldestDay = () => day(now() - 89 * DAY);

  async function append(record) {
    const safe = sanitize(record);
    if (!safe || day(safe.ts) < oldestDay() || safe.ts > now() + DAY) return;
    await ready;
    await appendFile(join(directory, `${day(safe.ts)}.jsonl`), JSON.stringify(safe) + '\n', { mode: 0o600 });
  }
  function enqueue(record) {
    if (queued >= 1024 || closed) {
      dropped++;
      return;
    }
    queued++;
    writes = writes
      .then(() => append(record))
      .catch(() => {
        dropped++;
      })
      .finally(() => {
        queued--;
      });
  }
  async function projectFor(cwd) {
    if (projects.has(cwd)) return projects.get(cwd);
    let project = text(cwd, 2048);
    try {
      project = text((await resolveProject(cwd))?.cwd, 2048) || project;
    } catch {}
    if (projects.size >= 256) projects.delete(projects.keys().next().value);
    projects.set(cwd, project);
    return project;
  }
  function noteEvent(run, event) {
    try {
      let state = timing.get(run);
      if (!state) {
        state = { start: Date.parse(run.startedAt) || now(), ttft: null, done: false };
        timing.set(run, state);
        const model = text(run.model),
          slash = model.indexOf('/');
        state.base = {
          sessionId: run.sessionId,
          project: run.projectCwd || run.cwd,
          provider: slash < 0 ? '' : model.slice(0, slash),
          model: slash < 0 ? model : model.slice(slash + 1),
        };
        enqueue({ ...state.base, id: `run:${run.id}:start`, type: 'run_start', ts: state.start });
      }
      // The normalized stream uses assistant text/thinking deltas, not full messages.
      if (
        state.ttft === null &&
        ['text', 'thinking'].includes(event.kind) &&
        typeof event.delta === 'string' &&
        event.delta.length > 0
      )
        state.ttft = Math.max(0, now() - state.start);
      if (event.kind !== 'done' || state.done) return;
      state.done = true;
      const status = event.status || ((event.code ?? 0) === 0 ? 'completed' : 'failed');
      enqueue({
        ...state.base,
        sessionId: run.sessionId,
        id: `run:${run.id}:end`,
        type: 'run_end',
        ts: now(),
        durationMs: Math.max(0, now() - state.start),
        ttftMs: state.ttft,
        status,
        // Never persist an error message: only a closed, low-cardinality class.
        errorClass: status === 'stopped' ? 'cancelled' : status === 'failed' ? 'runtime' : null,
      });
      scheduleMaintenance();
    } catch {
      dropped++;
    }
  }
  async function ingest(file, historical) {
    const key = hash(resolve(file));
    const cursorFile = join(cursorDir, `${key}.json`);
    const info = await stat(file);
    let cursor = {};
    try {
      cursor = JSON.parse(await readFile(cursorFile, 'utf8'));
    } catch {}
    if (cursor.size === info.size && cursor.mtime === info.mtimeMs) return;
    let offset = Number.isSafeInteger(cursor.offset) && cursor.offset <= info.size ? cursor.offset : 0;
    if (info.size === cursor.size && info.mtimeMs !== cursor.mtime) offset = 0;
    let header = offset ? cursor.header : null;
    let project = offset ? cursor.project : '';
    for await (const entry of lines(file, offset, info.size)) {
      if (closed) break;
      offset = entry.offset;
      const value = entry.value;
      if (!value) continue;
      if (historical) {
        if (value.type === 'session') {
          header = {
            id: text(value.id),
            parentSession: text(value.parentSession),
            depth: number(value.rlmDepth),
          };
          project = await projectFor(value.cwd);
        }
        if (['compaction', 'branch_summary'].includes(value.type) && header?.id) {
          const ts = Date.parse(value.timestamp);
          if (Number.isFinite(ts))
            await append({
              ...header,
              sessionId: header.id,
              project,
              id: `summary:${header.id}:${text(value.id)}`,
              type: value.type === 'compaction' ? 'session_compact' : 'branch_summary',
              ts,
              usage: value.usage,
              provider: '',
              model: '',
            });
          continue;
        }
        // Read native serialized own usage only. child_usage_attributed rows
        // overlay parent usage in the engine; replaying them would count children twice.
        if (
          value.type !== 'message' ||
          value.message?.role !== 'assistant' ||
          !value.message.usage ||
          !header?.id
        )
          continue;
        const message = value.message;
        const ts = number(message.timestamp) ?? Date.parse(value.timestamp);
        if (!Number.isFinite(ts)) continue;
        await append({
          ...header,
          sessionId: header.id,
          project,
          id: `message:${header.id}:${number(message.timestamp) ?? text(value.id)}`,
          type: 'message_end',
          ts,
          messageTs: number(message.timestamp),
          provider: message.provider,
          model: message.model,
          usage: message.usage,
          stopReason: message.stopReason,
        });
      } else {
        const isSummary = ['session_compact', 'branch_summary'].includes(value.type);
        const ts =
          isSummary && number(value.entryTs) > 0
            ? value.entryTs
            : value.type === 'message_end' && number(value.messageTs) > 0
              ? value.messageTs
              : value.ts;
        await append({
          ...value,
          ts,
          project: await projectFor(value.cwd),
          id:
            isSummary && value.entryId
              ? `summary:${text(value.sessionId)}:${text(value.entryId)}`
              : value.type === 'message_end' && number(value.messageTs) > 0
                ? `message:${text(value.sessionId)}:${value.messageTs}`
                : value.id,
        });
      }
    }
    // Persist only after ledger appends. A crash can replay rows; deterministic ids
    // make that harmless to summaries. Atomic replacement protects concurrent readers.
    if (closed) return;
    await writeFile(
      `${cursorFile}.tmp`,
      JSON.stringify({ offset, size: info.size, mtime: info.mtimeMs, header, project }),
      { mode: 0o600 },
    );
    await rename(`${cursorFile}.tmp`, cursorFile);
  }
  async function* files(root, depth = 0) {
    if (!root || depth > 6) return;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (closed) return;
      const file = join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
      else if (entry.isDirectory() && !entry.name.startsWith('.')) yield* files(file, depth + 1);
      await yieldTurn();
    }
  }
  async function prune() {
    for (const name of await readdir(directory)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < oldestDay())
        await rm(join(directory, name), { force: true });
    }
    for await (const file of files(rawDir)) {
      const partition = /^(\d{4}-\d{2}-\d{2})--/.exec(basename(file));
      if (partition ? partition[1] < oldestDay() : (await stat(file)).mtimeMs < now() - 90 * DAY) {
        await rm(file, { force: true });
        await rm(join(cursorDir, `${hash(resolve(file))}.json`), { force: true });
      }
    }
  }
  function refresh() {
    if (closed) return Promise.resolve();
    if (background) return background;
    scanFailed = false;
    generation++;
    projects.clear();
    background = (async () => {
      await ready;
      await prune();
      const activeCursors = new Set();
      for (const root of [rawDir, sessionDir, artifactDir]) {
        for await (const file of files(root)) {
          activeCursors.add(`${hash(resolve(file))}.json`);
          try {
            await ingest(file, root !== rawDir);
          } catch {
            scanFailed = true;
          }
        }
      }
      if (!closed) {
        for (const name of await readdir(cursorDir))
          if (name.endsWith('.json') && !activeCursors.has(name))
            await rm(join(cursorDir, name), { force: true });
        scanComplete = true;
      }
    })()
      .catch(() => {
        scanFailed = true;
      })
      .finally(() => {
        background = null;
        lastScan = now();
      });
    return background;
  }
  function scheduleMaintenance() {
    if (closed) return;
    clearTimeout(maintenance);
    maintenance = setTimeout(() => {
      maintenance = null;
      // A running scan may already have snapshotted the just-completed session.
      if (background) {
        void background.then(scheduleMaintenance);
        return;
      }
      void refresh();
    }, Math.max(1000, lastScan + 30000 - now()));
    maintenance.unref();
  }
  // One deferred startup pass and debounced completion passes, never a resident interval.
  scheduleMaintenance();
  function summary({ from, to, groupBy = 'day', project = '' } = {}) {
    from ||= oldestDay();
    to ||= day(now());
    const key = JSON.stringify([from, to, groupBy, project]);
    if (summaries.has(key)) return summaries.get(key);
    // A single scan at a time bounds I/O and allocations across distinct query ranges.
    const result = summaryQueue.then(() => readSummary({ from, to, groupBy, project }));
    summaries.set(key, result);
    summaryQueue = result.catch(() => {});
    void result.finally(() => summaries.delete(key)).catch(() => {});
    return result;
  }
  async function readSummary({ from, to, groupBy, project }) {
    const validDay = (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      day(Date.parse(value)) === value;
    from ||= oldestDay();
    to ||= day(now());
    if (
      !validDay(from) || !validDay(to) || from > to ||
      !['day', 'model', 'project'].includes(groupBy) ||
      (project && !/^[a-f0-9]{64}$/.test(project))
    )
      throw Object.assign(new Error('Invalid metrics range or grouping'), { status: 400 });
    if (background) await background;
    else if (!scanComplete || now() - lastScan >= 30000) await refresh();
    const scanGeneration = generation;
    await ready;
    await writes;
    const groups = new Map();
    const labels = new Map();
    const budget = { bytes: 0 };
    const total = aggregate();
    let count = 0,
      truncated = false;
    const names = (await readdir(directory))
      .filter(
        (name) =>
          /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) &&
          name.slice(0, 10) >= from &&
          name.slice(0, 10) <= to &&
          name.slice(0, 10) >= oldestDay(),
      )
      .sort()
      .reverse();
    // Hard query budget bounds dedup and exact timing samples. Never claim a
    // complete answer when this limit is reached; cockpit can narrow the range.
    outer: for (const name of names) {
      const seen = new Set();
      for await (const { value } of lines(join(directory, name), 0, Infinity, budget)) {
        count++;
        const record = sanitize(value);
        if (record && !seen.has(record.id)) {
          seen.add(record.id);
          const projectId = hash(record.project || 'unknown');
          if (!project || projectId === project) {
            const key =
              groupBy === 'day'
                ? day(record.ts)
                : groupBy === 'model'
                  ? `${record.provider || 'unknown'}/${record.model || 'unknown'}`
                  : projectId;
            if (!groups.has(key)) {
              groups.set(key, aggregate());
              if (groupBy === 'project') {
                let name;
                try {
                  name = (await resolveProject(record.project))?.name;
                } catch {}
                labels.set(
                  key, basename(text(name || record.project, 2048).replaceAll('\\', '/')) || 'Unknown project',
                );
              }
            }
            add(groups.get(key), record);
            add(total, record);
          }
        }
        if (count >= MAX_RECORDS) {
          truncated = true;
          break outer;
        }
      }
      if (budget.bytes >= MAX_BYTES) {
        truncated = true;
        break;
      }
    }
    return {
      from,
      to,
      groupBy,
      project,
      retentionDays: 90,
      cacheHitRatioDefinition: 'cacheRead / (input + cacheRead + cacheWrite)',
      costSource: 'engine-reported estimate',
      backfilling: Boolean(background),
      complete:
        scanComplete && !background && generation === scanGeneration && !scanFailed && !truncated && dropped === 0,
      truncated,
      dropped,
      scanFailed,
      maxRecords: MAX_RECORDS,
      maxBytes: MAX_BYTES,
      rowsRead: count,
      bytesRead: budget.bytes,
      totals: finish(total),
      groups: [...groups]
        .map(([key, value]) => ({ key, ...(groupBy === 'project' ? { name: labels.get(key) } : {}), ...finish(value) }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }
  async function close() {
    closed = true;
    clearTimeout(maintenance);
    await summaryQueue;
    await background;
    await writes;
  }
  return { rawDir, noteEvent, summary, refresh, close };
}

function aggregate() {
  return {
    runs: 0,
    finishedRuns: 0,
    completedRuns: 0,
    turns: 0,
    messages: 0,
    toolCalls: 0,
    compactions: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    costKnown: true,
    unknownCostMessages: 0,
    summary: {
      count: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      costKnown: true,
    },
    errors: { '4xx': 0, '5xx': 0, runtime: 0, cancelled: 0 },
    durations: [],
    ttfts: [],
  };
}
function add(value, record) {
  if (record.type === 'run_start') value.runs++;
  if (record.type === 'run_end') {
    value.finishedRuns++;
    if (record.status === 'completed') value.completedRuns++;
    if (record.errorClass) value.errors[record.errorClass]++;
    if (number(record.durationMs) !== null) value.durations.push(record.durationMs);
    if (number(record.ttftMs) !== null) value.ttfts.push(record.ttftMs);
  }
  if (record.type === 'turn_end') value.turns++;
  if (record.type === 'tool_execution_end') value.toolCalls++;
  if (record.type === 'session_compact') value.compactions++;
  if (record.type === 'after_provider_response' && record.status >= 400 && record.status < 600)
    value.errors[record.status < 500 ? '4xx' : '5xx']++;
  const isSummary = ['session_compact', 'branch_summary'].includes(record.type);
  if (record.type !== 'message_end' && !isSummary) return;
  if (isSummary) {
    value.summary.count++;
    for (const key of Object.keys(value.tokens)) value.summary.tokens[key] += record.usage?.[key] || 0;
    if (number(record.usage?.cost) === null) value.summary.costKnown = false;
    else value.summary.cost += record.usage.cost;
  } else value.messages++;
  for (const key of Object.keys(value.tokens)) value.tokens[key] += record.usage?.[key] || 0;
  if (number(record.usage?.cost) === null) {
    value.costKnown = false;
    value.unknownCostMessages++;
  } else value.cost += record.usage.cost;
}
function stats(values) {
  if (!values.length) return { count: 0, avgMs: null, medianMs: null };
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    count: values.length,
    avgMs: values.reduce((a, b) => a + b, 0) / values.length,
    medianMs: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
  };
}
function finish({ durations, ttfts, ...value }) {
  const input = value.tokens.input + value.tokens.cacheRead + value.tokens.cacheWrite;
  return {
    ...value,
    cacheHitRatio: input ? value.tokens.cacheRead / input : null,
    duration: stats(durations),
    timeToFirstToken: stats(ttfts),
  };
}
