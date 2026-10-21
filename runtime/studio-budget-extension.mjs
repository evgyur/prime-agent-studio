// Safe-point budgets. A response already in flight can exceed a limit.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const empty = () => ({ tokens: 0, estimatedCost: 0, costKnown: true });
const add = (a, b) => { a.tokens += b.tokens; a.estimatedCost += b.estimatedCost; a.costKnown &&= b.costKnown; };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validDecision = (value) => object(value) && Object.keys(value).length === 4 &&
  Number.isSafeInteger(value.revision) && value.revision >= 0 && Number.isFinite(value.multiplier) && value.multiplier >= 1 &&
  typeof value.unlimited === 'boolean' && typeof value.stopped === 'boolean';
const validUsage = (value) => object(value) && Object.keys(value).length === 5 &&
  nonnegative(value.tokens) && nonnegative(value.estimatedCost) && typeof value.costKnown === 'boolean' &&
  typeof value.runId === 'string' && /^[a-zA-Z0-9-]+$/.test(value.runId) && typeof value.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.day);
const choices = ['Continue +50%', 'Unlimited this run', 'Stop'];
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

export function createBudgetGuard(config, publish) {
  const instance = randomUUID();
  const local = new Map();
  let decision = { revision: 0, multiplier: 1, unlimited: false, stopped: false };
  let localStopped = false, child = false;
  let lastStatus = '', ledgerError = false, stopReason = null;
  const shared = config.ledgerDir && config.projectKey && config.runId;
  if (shared) mkdirSync(config.ledgerDir, { recursive: true });
  const decisionFile = shared ? join(config.ledgerDir, `${config.runId}.decision.json`) : null;
  const stopFile = shared ? join(config.ledgerDir, `${config.runId}.stopped`) : null;
  const today = () => new Date().toISOString().slice(0, 10);
  function refreshDecision() {
    if (!decisionFile) return;
    try {
      const next = JSON.parse(readFileSync(decisionFile, 'utf8'));
      if (!validDecision(next)) throw new Error('Invalid decision');
      decision = next;
    }
    catch (error) { if (error.code !== 'ENOENT') ledgerError = true; }
    try {
      if (readFileSync(stopFile, 'utf8') !== 'stopped\n') ledgerError = true;
      decision.stopped = true;
    } catch (error) { if (error.code !== 'ENOENT') ledgerError = true; }
  }
  function totals() {
    const run = empty(), project = empty();
    try {
      if (shared) {
        for (const name of readdirSync(config.ledgerDir)) {
          if (!name.startsWith(`${config.projectKey}--`) || !name.endsWith('.usage.json')) continue;
          const entry = JSON.parse(readFileSync(join(config.ledgerDir, name), 'utf8'));
          if (!validUsage(entry)) throw new Error('Invalid usage ledger');
          if (entry.runId === config.runId) add(run, entry);
          if (entry.day === today()) add(project, entry);
        }
      } else for (const [day, entry] of local) { add(run, entry); if (day === today()) add(project, entry); }
    } catch { ledgerError = true; }
    return { run, project };
  }
  function limits(base) {
    return Object.fromEntries(['tokens', 'estimatedCost'].map((key) => [key,
      decision.unlimited || !base?.[key] ? null : Math.min(Number.MAX_VALUE, base[key] * decision.multiplier)]));
  }
  function state(status) {
    refreshDecision();
    const { run, project } = totals();
    return { status: status || (decision.stopped || localStopped ? 'stopped' : 'ok'), ...run, limits: limits(config), project: { ...project, limits: limits(config.project), period: 'day' },
      ...(ledgerError ? { reason: 'ledger_unavailable' } : stopReason ? { reason: stopReason } : {}) };
  }
  function emit(status) {
    const value = state(status);
    try { if (!child) publish(value); } catch { ledgerError = true; }
    lastStatus = status;
    return value;
  }
  function ratio(usage, cap) {
    return Math.max(...['tokens', 'estimatedCost'].map((key) => cap[key] ? usage[key] / cap[key] : 0));
  }
  function exceeded(value, threshold) {
    return ratio(value, value.limits) >= threshold || ratio(value.project, value.project.limits) >= threshold;
  }
  function record(usage, priceKnown = true) {
    const day = today();
    const value = local.get(day) || empty();
    value.tokens += finite(usage?.input) + finite(usage?.output) + finite(usage?.cacheRead) + finite(usage?.cacheWrite);
    const cost = typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total;
    value.estimatedCost += finite(cost);
    value.costKnown &&= typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && (cost > 0 || priceKnown);
    local.set(day, value);
    if (shared) try {
      atomic(join(config.ledgerDir, `${config.projectKey}--${day}--${config.runId}--${instance}.usage.json`),
        { ...value, day, runId: config.runId });
    } catch { ledgerError = true; }
    const current = state('ok');
    emit(decision.stopped ? 'stopped' : decision.unlimited ? 'unlimited' : exceeded(current, 0.8) ? 'warning' : 'ok');
  }
  async function check(ctx) {
    child = !!ctx.sessionManager?.getHeader?.()?.parentSession;
    const current = state('ok');
    if (localStopped) { ctx.abort(); return; }
    const unknownCost = (!current.costKnown && current.limits.estimatedCost) ||
      (!current.project.costKnown && current.project.limits.estimatedCost);
    if (decision.stopped || ledgerError || unknownCost) {
      if (unknownCost) stopReason = 'cost_unknown';
      decision.stopped = true;
    } else if (!exceeded(current, 1)) {
      if (exceeded(current, 0.8) && lastStatus !== 'warning') emit('warning');
      return;
    } else if (config.allowQuestions === true && child) {
      // The root owns recoverable decisions. A child stops only its own work.
      localStopped = true;
      ctx.abort();
      return;
    } else if (config.allowQuestions === true && ctx.ui?.select) {
      emit('paused');
      let selected;
      try { selected = await ctx.ui.select('Budget reached', choices, { signal: ctx.signal }); } catch { /* cancellation stops */ }
      refreshDecision(); // Never let an answer revive a concurrent terminal stop.
      if (decision.stopped || ledgerError) decision.stopped = true;
      else if (selected === choices[0]) {
        decision.multiplier *= 1.5;
        if (!Number.isFinite(decision.multiplier)) { ledgerError = true; decision.stopped = true; }
      }
      else if (selected === choices[1]) decision.unlimited = true;
      else decision.stopped = true;
    } else decision.stopped = true;
    if (decisionFile) try {
      if (decision.stopped) {
        // Immutable terminal marker wins over every concurrent/stale root answer.
        try { writeFileSync(stopFile, 'stopped\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } else {
        decision.revision++;
        atomic(decisionFile, decision);
      }
      refreshDecision();
    } catch { ledgerError = true; decision.stopped = true; }
    if (decision.stopped) {
      emit('stopped');
      ctx.abort(); // Throwing from extension hooks is swallowed by the native runner.
    } else {
      emit(decision.unlimited ? 'unlimited' : 'extended');
      if (!decision.unlimited && exceeded(state('ok'), 1)) await check(ctx);
    }
  }
  return { record, check, state };
}

export default function studioBudget(pi) {
  if (!process.env.PRIME_STUDIO_BUDGET) return;
  const config = JSON.parse(process.env.PRIME_STUDIO_BUDGET);
  const guard = createBudgetGuard(config, (budget) => {
    if (config.statusFile) atomic(config.statusFile, { ...budget, revision: randomUUID() });
  });
  pi.on('message_end', ({ message }, ctx) => {
    if (message?.role === 'assistant') guard.record(message.usage, Object.values(ctx.model?.cost || {}).some((n) => finite(n) > 0));
  });
  pi.on('session_compact', ({ compactionEntry }) => {
    if (compactionEntry?.usage) guard.record(compactionEntry.usage, false);
  });
  pi.on('session_tree', ({ summaryEntry }) => {
    if (summaryEntry?.usage) guard.record(summaryEntry.usage, false);
  });
  pi.on('before_provider_request', (_event, ctx) => guard.check(ctx));
  // Stop tool execution as well: budgets pause at the next safe boundary, not mid-tool.
  pi.on('tool_call', async (_event, ctx) => {
    await guard.check(ctx);
    if (guard.state().status === 'stopped') return { block: true, reason: 'Budget reached' };
  });
}
