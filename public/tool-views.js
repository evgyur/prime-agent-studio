import { TOOL_KINDS, toolKindOf } from './docking-layout.js';

export const TOOL_STORAGE_KEY = 'docking.tools';
const MAX_STORED_TOOLS = 64;
const reference = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const viewReference = (value) =>
  typeof value === 'string' && /^(conversation|conv:[A-Za-z0-9_-]{1,64})$/.test(value);
const pathKey = (value) => {
  const path = String(value || '');
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || /^\/\/[^/]/.test(path))
    return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return path.length > 1 ? path.replace(/\/$/, '') : path;
};
const samePath = (left, right) => pathKey(left) === pathKey(right);

export function sameToolContext(left, right) {
  if (
    !left ||
    !right ||
    left.unavailable ||
    right.unavailable ||
    !left.projectCwd ||
    !samePath(left.projectCwd, right.projectCwd) ||
    left.sessionId !== right.sessionId
  )
    return false;
  if (left.sessionId) return true;
  if (left.run?.id || right.run?.id) return left.run?.id === right.run?.id;
  return Boolean(left.view?.id && left.view.id === right.view?.id && left.view.nonce === right.view?.nonce);
}

export function captureToolTarget(view, run = null) {
  if (!view?.projectCwd) return null;
  return {
    projectCwd: view.projectCwd,
    execCwd: view.execCwd || view.projectCwd,
    sessionId: view.sessionId || run?.sessionId || null,
    viewRunId: view.viewRunId || run?.id || null,
    viewId: view.id || null,
    nonce: view.nonce || null,
  };
}

function validTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const path = (entry) =>
    typeof entry === 'string' && entry.length > 0 && entry.length <= 4096 && !entry.includes('\0');
  if (!path(value.projectCwd) || (value.execCwd != null && !path(value.execCwd))) return null;
  if (value.sessionId != null && !reference(value.sessionId)) return null;
  if (value.viewRunId != null && !reference(value.viewRunId)) return null;
  if (value.viewId != null && !viewReference(value.viewId)) return null;
  if (value.nonce != null && !reference(value.nonce)) return null;
  if (!value.sessionId && !value.viewRunId && !(value.viewId && value.nonce)) return null;
  return {
    projectCwd: value.projectCwd,
    execCwd: value.execCwd || value.projectCwd,
    sessionId: value.sessionId || null,
    viewRunId: value.viewRunId || null,
    viewId: value.viewId || null,
    nonce: value.nonce || null,
  };
}

export function validateToolBindings(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_STORED_TOOLS
  )
    return null;
  const entries = [];
  const seen = new Set();
  for (const item of value.entries) {
    if (!item || !toolKindOf(item.id) || seen.has(item.id) || typeof item.locked !== 'boolean') return null;
    seen.add(item.id);
    const target = item.locked ? validTarget(item.target) : null;
    // An unreadable lock stays locked/unavailable. Never silently follow a
    // different active conversation after partial storage loss.
    entries.push({ id: item.id, locked: item.locked, target });
  }
  return { version: 1, entries };
}

// Resolve identifiers against LIVE data. Pins never cache permissions, content,
// generation settings, or a mutable conversation-view object.
export function resolveToolTarget(
  target,
  { focused, views = [], projects = [], runs = [], ready = true } = {},
) {
  const pinned = !!target;
  const source = pinned ? target : captureToolTarget(focused);
  if (!source)
    return {
      unavailable: false,
      project: null,
      view: focused || null,
      session: null,
      run: null,
      projectCwd: null,
      execCwd: null,
      sessionId: null,
    };
  const project = projects.find((item) => samePath(item.cwd, source.projectCwd)) || null;
  let view = null;
  let sessionId = source.sessionId;
  let run = source.viewRunId ? runs.find((item) => item.id === source.viewRunId) : null;
  if (pinned) {
    if (sessionId)
      view =
        views.find((item) => item.sessionId === sessionId && samePath(item.projectCwd, source.projectCwd)) ||
        null;
    else if (source.viewRunId)
      view =
        views.find(
          (item) => item.viewRunId === source.viewRunId && samePath(item.projectCwd, source.projectCwd),
        ) || null;
    else
      view =
        views.find(
          (item) =>
            item.id === source.viewId &&
            item.nonce === source.nonce &&
            samePath(item.projectCwd, source.projectCwd),
        ) || null;
  } else view = focused || null;
  // An unsent draft may acquire ITS OWN session through its retained nonce.
  // Explicit rebinding rotates that nonce, so it cannot hijack an old pin.
  if (!sessionId && view) {
    sessionId = view.sessionId || null;
    run ||= runs.find((item) => item.id === view.viewRunId) || null;
  }
  sessionId ||= run?.sessionId || null;
  const session = (sessionId && project?.sessions?.find((item) => item.id === sessionId)) || null;
  if (sessionId)
    run =
      runs.find((item) => item.sessionId === sessionId && ['running', 'stopping'].includes(item.status)) ||
      null;
  const pendingSession = run && samePath(run.cwd, view?.execCwd || source.execCwd || source.projectCwd);
  const liveUnboundRun = pendingSession && ['running', 'stopping'].includes(run.status);
  const missing =
    !project || (pinned && (sessionId ? !session && !pendingSession : !view && !liveUnboundRun));
  const unavailable = ready && missing;
  return {
    unavailable,
    project,
    session,
    view,
    run,
    projectCwd: project?.cwd || source.projectCwd,
    execCwd: session?.cwd || view?.execCwd || run?.cwd || source.execCwd || source.projectCwd,
    sessionId,
    // Persist promotion before a source tab is closed or rebound.
    promoted:
      pinned && !source.sessionId && sessionId
        ? { ...source, sessionId, viewRunId: run?.id || null }
        : pinned && !source.viewRunId && run?.id
          ? { ...source, viewRunId: run.id }
          : null,
  };
}

export function createToolViews({ read, write, getSnapshot, create, onChange = () => {} }) {
  const stored = read(TOOL_STORAGE_KEY, null);
  const restored = validateToolBindings(stored);
  const entries = new Map(
    (restored?.entries || []).map((item) => [
      item.id,
      { ...item, kind: toolKindOf(item.id), ui: null, root: null },
    ]),
  );
  for (const kind of TOOL_KINDS) {
    if (!entries.has(kind) && entries.size < MAX_STORED_TOOLS)
      entries.set(kind, {
        id: kind,
        kind,
        locked: stored != null && !restored,
        target: null,
        ui: null,
        root: null,
      });
  }
  let sequence = 0;
  const persist = () =>
    write(TOOL_STORAGE_KEY, {
      version: 1,
      entries: [...entries.values()].map(({ id, locked, target }) => ({ id, locked, target })),
    });
  function context(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    const snapshot = getSnapshot();
    if (entry.locked && !entry.target)
      return {
        unavailable: true,
        project: null,
        session: null,
        view: null,
        run: null,
        projectCwd: null,
        execCwd: null,
        sessionId: null,
      };
    const result = resolveToolTarget(entry.locked ? entry.target : null, snapshot);
    // Performance pins a project, not the continued existence of a session.
    if (entry.kind === 'performance') result.unavailable = snapshot.ready !== false && !result.project;
    if (result.promoted) {
      entry.target = result.promoted;
      persist();
    }
    return result;
  }
  function ensure(id, { restored: recovering = false } = {}) {
    const kind = toolKindOf(id);
    if (!kind) return null;
    let entry = entries.get(id);
    const fresh = !entry;
    if (!entry) {
      if (entries.size >= MAX_STORED_TOOLS) return null;
      entry = { id, kind, locked: recovering, target: null, ui: null, root: null };
      entries.set(id, entry);
    }
    if (!entry.root) {
      try {
        const owner = create(entry);
        if (!owner?.root) {
          if (fresh) entries.delete(id);
          return null;
        }
        Object.assign(entry, owner);
      } catch (error) {
        (entry.ui?.dispose || entry.ui?.destroy)?.call(entry.ui);
        entry.passkeys?.dispose?.();
        entry.push?.dispose?.();
        entry.root?.remove?.();
        entry.home?.remove?.();
        entry.passkeyRoot?.remove?.();
        entry.ui = entry.root = null;
        if (fresh) entries.delete(id);
        throw error;
      }
    }
    return entry;
  }
  function createView(kind) {
    if (!TOOL_KINDS.includes(kind)) return null;
    if (entries.size >= MAX_STORED_TOOLS) {
      const open = new Set(getSnapshot().panelIds || []);
      const parked = [...entries.values()].find(
        (entry) => entry.kind === kind && entry.id.startsWith('tool:') && !open.has(entry.id),
      );
      return parked ? ensure(parked.id) : null;
    }
    let id;
    do {
      id = `tool:${kind}:v${Date.now().toString(36)}${(++sequence).toString(36)}`;
    } while (entries.has(id));
    const entry = ensure(id);
    if (entry) persist();
    return entry;
  }
  // The run belongs to the submitted draft even if its view was rebound while
  // POST /api/runs was in flight. Match the captured nonce, never current focus.
  function bindDraftRun(viewId, nonce, run) {
    let changed = false;
    for (const entry of entries.values()) {
      const target = entry.target;
      if (!entry.locked || !target || target.sessionId || target.viewId !== viewId || target.nonce !== nonce)
        continue;
      entry.target = { ...target, viewRunId: run.id, sessionId: run.sessionId || null };
      changed = true;
    }
    if (changed) persist();
  }
  function toggleLock(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.locked) {
      entry.locked = false;
      entry.target = null;
    } else {
      const snapshot = getSnapshot();
      const current = resolveToolTarget(null, snapshot);
      const target = captureToolTarget(snapshot.focused, current.run);
      if (!target || current.unavailable || snapshot.ready === false) return false;
      entry.target = target;
      entry.locked = true;
    }
    persist();
    onChange(entry);
    return true;
  }
  return { entries, context, ensure, createView, toggleLock, bindDraftRun, persist };
}
