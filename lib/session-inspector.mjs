import { formatMessage as tr } from '../public/i18n-core.js';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverCli } from './agent.mjs';
import { cwdKey, HttpError, validId } from './store.mjs';

const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value, max = 1500) => (typeof value === 'string' ? value.slice(0, max) : '');
function sanitizeContextUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const contextWindow = value.contextWindow;
  if (
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    contextWindow > 100_000_000
  )
    return undefined;
  const tokens =
    value.tokens === null
      ? null
      : typeof value.tokens === 'number' && Number.isFinite(value.tokens) && value.tokens >= 0
        ? Math.round(value.tokens)
        : undefined;
  const percent =
    value.percent === null
      ? null
      : typeof value.percent === 'number' && Number.isFinite(value.percent)
        ? Math.min(100, Math.max(0, Math.round(value.percent * 10) / 10))
        : undefined;
  if (tokens === undefined && percent === undefined) return undefined;
  return { tokens: tokens ?? null, contextWindow: Math.round(contextWindow), percent: percent ?? null };
}
export function agentStatus(state = {}) {
  if (state.isCompacting) return 'compacting';
  if (state.isRunningTools || state.isBashRunning) return 'tool';
  if (state.isStreaming) return 'working';
  if (state.hasRunningRlmChildren) return 'children';
  // Honest background: the engine holds the session (background handle or
  // resident task) but shows no active streaming, tool, or child work. Do not
  // label this working and never infer a resident service from silence alone.
  if (state.isSessionActive) return 'background';
  return 'idle';
}
// pi-ai normalizes Anthropic, OpenAI chat/responses and Google input to
// uncached tokens. Cache hit ratio = read / (input + read + write), never output.
// The store caches parsed histories by file size/mtime; retain only their numeric
// summary here so unchanged, large histories are not walked on every refresh.
const usageCache = new WeakMap();
function usage(messages = []) {
  if (usageCache.has(messages)) return usageCache.get(messages);
  const result = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let present = false,
    costKnown = true;
  for (const message of messages) {
    const own = message.ownUsage ?? message.usage;
    if (message.role !== 'assistant' || !own) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'])
      if (finite(own[key])) {
        result[key] += own[key];
        present = true;
      }
    if (finite(own.cost?.total)) result.cost += own.cost.total;
    else costKnown = false;
  }
  const value = present ? finishUsage({ ...result, cost: costKnown ? result.cost : null }) : null;
  usageCache.set(messages, value);
  return value;
}
function finishUsage(value) {
  const prompt = value.input + value.cacheRead + value.cacheWrite;
  return {
    ...value,
    cache: value.cacheRead + value.cacheWrite,
    cacheHitRatio: prompt > 0 ? value.cacheRead / prompt : null,
  };
}
function totalUsage(agents) {
  const values = agents.map((agent) => agent.usage).filter(Boolean);
  if (!values.length) return null;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const value of values)
    for (const key of Object.keys(sum)) sum[key] += value[key] || 0;
  if (values.length !== agents.length || values.some((value) => value.cost === null)) sum.cost = null;
  return finishUsage(sum);
}
function childStatus(child) {
  // A retained child can work again after its initial task has finished.
  if (child.activity?.kind === 'executing') return 'tool';
  if (child.activity?.kind === 'writing') return 'working';
  if (child.activity?.kind === 'waiting') return 'waiting';
  return (
    { queued: 'queued', running: 'working', done: 'completed', error: 'failed', cancelled: 'stopped' }[
      child.status
    ] || 'unknown'
  );
}

export function createSessionInspector({ store, agentHome, sessionDir, getClient, getRun, readEdges }) {
  let ledger;
  const readNativeEdges =
    readEdges ||
    (async () => {
      if (!ledger) {
        const cli = discoverCli();
        if (!cli?.packageDir) return [];
        const { RlmSpawnLedger } = await import(
          pathToFileURL(join(cli.packageDir, 'dist/modes/daemon/rlm-ledger.js')).href
        );
        // No seed source: reads must never create or repair a native ledger.
        ledger = new RlmSpawnLedger(agentHome, sessionDir);
      }
      return ledger.liveEdges();
    });
  const cache = new Map();
  async function inspect(cwd, id) {
    const project = await store.findProject(cwd);
    if (!id) return { session: null, agents: [], live: false };
    if (!validId(id)) throw new HttpError(400, tr('server.session_invalide'));
    const root = await store.history(id);
    if (cwdKey(root.cwd) !== cwdKey(project.cwd))
      throw new HttpError(404, tr('server.session_introuvable_dans_ce_projet'));
    const key = `${cwdKey(cwd)}\0${id}`,
      cached = cache.get(key);
    const runId = getRun(id)?.id;
    if (cached && cached.runId === runId && Date.now() - cached.at < 2000) return cached.promise;
    const promise = build(root);
    cache.set(key, { at: Date.now(), promise, runId, sessionId: id });
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
  }
  async function build(root) {
    const run = getRun(root.id),
      notes = [];
    const running = run && ['running', 'stopping'].includes(run.status);
    let live;
    if (running) {
      const client = getClient();
      try {
        live = await client?.getInspector(root.id, root.cwd);
      } catch {
        notes.push(tr('server.le_suivi_en_direct_est_momentanement_indisponible'));
      } finally {
        client?.close?.();
      }
    }
    const liveStatus = live ? agentStatus(live.state) : null;
    const rootStatus =
      run?.status === 'stopping'
        ? 'stopping'
        : live
          ? liveStatus === 'idle' && running
            ? 'waiting'
            : liveStatus
          : running
            ? 'working'
            : run?.status === 'failed'
              ? 'failed'
              : run?.status === 'stopped'
                ? 'stopped'
                : 'idle';
    const rootAgent = {
      id: root.id,
      parentId: null,
      name: root.title,
      status: rootStatus,
      model: text(live?.state?.model, 400) || root.model,
      thinking: text(live?.state?.thinkingLevel, 20) || root.thinking,
      usage: usage(root.messages),
      messageCount: root.messageCount,
      history: true,
      root: true,
    };
    const agents = [rootAgent],
      files = new Map([[root.id, root.file]]);
    let incomplete = false;
    let edges = [];
    try {
      edges = await readNativeEdges();
    } catch {
      incomplete = true;
      notes.push(tr('server.l_historique_des_delegations_n_est_pas_disponible'));
    }
    const byParent = new Map();
    for (const edge of edges) {
      if (!edge.child || !edge.parent || !validId(edge.childId)) continue;
      const key = cwdKey(edge.parent);
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(edge);
    }
    const visited = new Set([cwdKey(root.file)]),
      queue = [{ file: root.file, id: root.id }];
    const artifactRoot = join(agentHome, 'session-artifacts', root.id);
    for (let cursor = 0; cursor < queue.length && agents.length < 201; cursor++) {
      const parent = queue[cursor];
      for (const edge of byParent.get(cwdKey(parent.file)) || []) {
        if (agents.length >= 201 || visited.has(cwdKey(edge.child))) continue;
        visited.add(cwdKey(edge.child));
        const actual = await realpath(edge.child).catch(() => null);
        if (
          !actual ||
          ![artifactRoot, sessionDir].some((dir) => cwdKey(actual).startsWith(cwdKey(dir) + sep))
        ) {
          incomplete = true;
          continue;
        }
        const info = await stat(actual).catch(() => null);
        if (!info?.isFile() || info.size > 16 * 1024 * 1024) {
          incomplete = true;
          continue;
        }
        const child = await store.inspectFile(actual);
        if (!child) {
          incomplete = true;
          continue;
        }
        const last = child.messages.findLast((message) => message.role === 'assistant');
        agents.push({
          id: edge.childId,
          parentId: parent.id,
          sessionId: child.id,
          name: edge.name || child.title,
          status:
            last?.error || last?.stopReason === 'error'
              ? 'failed'
              : last?.stopReason === 'aborted'
                ? 'stopped'
                : 'saved',
          model: child.model,
          thinking: child.thinking,
          usage: usage(child.messages),
          messageCount: child.messageCount,
          preview: text(last?.text),
          history: true,
          root: false,
        });
        files.set(edge.childId, actual);
        queue.push({ file: edge.child, id: edge.childId });
      }
    }
    for (const child of live?.children || []) {
      if (!validId(child.id)) continue;
      let row = agents.find((agent) => agent.id === child.id);
      if (!row) {
        if (agents.length >= 201) {
          incomplete = true;
          continue;
        }
        row = { id: child.id, root: false, history: false };
        agents.push(row);
      }
      Object.assign(row, {
        parentId: child.parentId || root.id,
        name: text(child.sessionName || child.label, 200) || 'Sous-agent',
        status: childStatus(child),
        model: text(child.model, 200),
        thinking: text(child.thinkingLevel, 20) || row.thinking,
        preview: text(child.recap || child.answerPreview),
        progressNote: text(child.progressNote, 512),
        lastActivityAt:
          finite(child.lastActivityAt) && child.lastActivityAt <= 8.64e15 ? child.lastActivityAt : undefined,
        // Native monotonic age deliberately stays unset while a tool executes.
        // Do not derive staleness from wall-clock time (host sleep is not inactivity).
        activityStaleMs:
          child.activity?.kind !== 'executing' && finite(child.activityStaleMs)
            ? child.activityStaleMs
            : undefined,
        error: text(child.error),
        durationMs: finite(child.durationMs) ? child.durationMs : undefined,
        toolUseCount: finite(child.toolUseCount) ? child.toolUseCount : undefined,
      });
    }
    const ids = new Set(agents.map((agent) => agent.id));
    for (const agent of agents)
      if (!agent.root && (!ids.has(agent.parentId) || agent.parentId === agent.id)) agent.parentId = root.id;
    // Live current context vs window only; never cumulative totals. Hidden when unavailable.
    const contextUsage = sanitizeContextUsage(live?.state?.contextUsage ?? live?.contextUsage);
    if (agents.length === 1 && root.messages.some((message) => message.ownUsage)) incomplete = true;
    const totals = totalUsage(agents);
    if (totals && incomplete) totals.cost = null;
    return {
      session: {
        id: root.id,
        status: rootStatus,
        usage: rootAgent.usage,
        totalUsage: totals,
        subagentCount: agents.length - 1,
        usageIncomplete: incomplete || agents.length >= 201 || agents.some((agent) => !agent.usage),
        lastRequestUsage: usage([
          root.messages.findLast((message) => message.role === 'assistant' && message.usage),
        ].filter(Boolean)),
        ...(contextUsage ? { contextUsage } : {}),
      },
      agents: agents.slice(0, 201),
      live: !!live,
      notes,
      truncated: agents.length >= 201,
      ...(contextUsage ? { contextUsage } : {}),
      files,
    };
  }
  return {
    invalidate(sessionId) {
      for (const [key, entry] of cache)
        if (entry.sessionId === sessionId) cache.delete(key);
    },
    async inspect(cwd, id) {
      const { files, ...data } = await inspect(cwd, id);
      return data;
    },
    async history(cwd, rootId, childId) {
      if (!validId(childId)) throw new HttpError(400, tr('server.agent_invalide'));
      const result = await inspect(cwd, rootId),
        file = result.files?.get(childId);
      if (!file) throw new HttpError(404, tr('server.historique_de_cet_agent_indisponible'));
      const actual = await realpath(file).catch(() => null);
      if (!actual || cwdKey(actual) !== cwdKey(file))
        throw new HttpError(404, tr('server.historique_deplace_actualisez_les_agents'));
      if (childId !== rootId) {
        const info = await stat(actual).catch(() => null);
        if (!info?.isFile() || info.size > 16 * 1024 * 1024)
          throw new HttpError(413, tr('server.historique_trop_volumineux'));
      }
      const history = await store.inspectFile(file);
      if (!history) throw new HttpError(404, tr('server.historique_introuvable'));
      return {
        title: result.agents.find((agent) => agent.id === childId)?.name || history.title,
        messages: history.messages.slice(-150),
        truncated: history.messages.length > 150,
      };
    },
  };
}
