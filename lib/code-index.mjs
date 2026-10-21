import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';

const inside = (root, target) => {
  const rel = relative(root, target);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

function stopWorker(worker) {
  return new Promise((resolveStopped) => {
    if (worker.exitCode !== null || worker.signalCode !== null) return resolveStopped();
    const done = () => { clearTimeout(timer); clearTimeout(escalate); resolveStopped(); };
    const timer = setTimeout(() => { try { worker.kill('SIGKILL'); } catch { /* Already gone. */ } }, 2000);
    const escalate = setTimeout(done, 5000);
    // 'close' fires once the process exited and its stdio pipes are released.
    worker.once('close', done);
    try { worker.kill(); } catch { done(); }
  });
}

// One low-priority process per active project; no source text enters Studio's event loop.
export async function codeIndexProjectId(project) {
  const root = await realpath(project.path);
  return /^[a-f0-9]{64}$/.test(project.metricsId || '') ? project.metricsId : createHash('sha256').update(root).digest('hex');
}

export function createCodeIndex({ dataDir, onUpdate = () => {}, readOnly = false }) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const entries = new Map();
  const liveWorkers = new Set();
  let closed = false;
  async function entry(project) {
    if (closed) throw new Error('Code index is closed');
    if (!project || typeof project.path !== 'string') throw new TypeError('Project path is required');
    const root = await realpath(project.path);
    const key = await codeIndexProjectId({ ...project, path: root });
    if (entries.has(key)) {
      if (entries.get(key).root !== root) throw new Error('Code index project identity mismatch');
      return entries.get(key);
    }
    const base = resolve(dataDir);
    if (inside(root, base)) throw new Error('Code index data must be outside the project');
    if (!readOnly) await mkdir(base, { recursive: true });
    if (inside(root, await realpath(base))) throw new Error('Code index data must be outside the project');
    const directory = join(base, 'code-index', key);
    if (!readOnly) await mkdir(directory, { recursive: true });
    const actualDirectory = await realpath(directory);
    if (!inside(await realpath(base), actualDirectory) || inside(root, actualDirectory)) throw new Error('Unsafe code index directory');
    // Recheck after awaits to avoid duplicate workers on concurrent first requests.
    if (entries.has(key)) {
      if (entries.get(key).root !== root) throw new Error('Code index project identity mismatch');
      return entries.get(key);
    }
    if (closed) throw new Error('Code index is closed');
    while (entries.size >= 8) {
      const idle = [...entries.entries()].filter(([, item]) => !item.pending.size && item.state.state !== 'indexing').sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) throw new Error('Code index workers are busy; retry shortly');
      entries.delete(idle[0]);
      await stopWorker(idle[1].worker);
      if (closed) throw new Error('Code index is closed');
      if (entries.has(key)) return entries.get(key);
    }
    const worker = fork(new URL('./code-index-worker.mjs', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      execArgv: [],
    });
    liveWorkers.add(worker);
    worker.once('exit', () => liveWorkers.delete(worker));
    if (closed) { void stopWorker(worker).then(() => liveWorkers.delete(worker)); throw new Error('Code index is closed'); }
    let sequence = 0;
    const pending = new Map();
    const item = { worker, root, pending, lastUsed: Date.now(), state: { state: 'starting', files: 0, chunks: 0, updatedAt: null } };
    item.request = (method, options = {}) => new Promise((resolveRequest, reject) => {
      item.lastUsed = Date.now();
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Code index request timed out'));
        worker.kill();
      }, 90_000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      worker.send({ id, method, options }, (error) => {
        if (!error) return;
        const request = pending.get(id);
        if (request) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    });
    worker.on('message', (message) => {
      if (message.event === 'update') {
        item.state = message.status;
        try { onUpdate(project, message.status); } catch { /* Consumer cannot stop indexing. */ }
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    const failed = () => {
      item.state = { ...item.state, state: 'error', error: 'Code index worker stopped' };
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(item.state.error)); }
      pending.clear();
      if (entries.get(key) === item) entries.delete(key);
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    entries.set(key, item);
    item.ready = item.request('init', { root, directory: actualDirectory, readOnly }).then((status) => {
      item.state = status;
      return status;
    }).catch((error) => { worker.kill(); throw error; });
    return item;
  }
  async function call(project, method, options) {
    try {
      const item = await entry(project);
      const initial = await item.ready;
      // Re-admitted writable indexes catch up before serving cached source and resume watching.
      // Read-only runtime tools never refresh, and a new index still requires explicit refresh.
      if (!readOnly && initial.updatedAt && ['search', 'symbols', 'map'].includes(method) && !item.activated) {
        item.activation ||= item.request('refresh', Array.isArray(options?.exclusions) ? { exclusions: options.exclusions } : {});
        await item.activation;
        item.activated = true;
      }
      const result = await item.request(method, options);
      if (method === 'refresh' && result.state === 'ready') item.activated = true;
      return result;
    } catch (error) {
      return { state: 'error', error: error.message, ...(['search', 'symbols', 'map'].includes(method) ? { results: [] } : {}) };
    }
  }
  return {
    ensureProject: (project) => call(project, 'status'),
    async status(project) {
      if (closed) return { state: 'error', error: 'Code index is closed' };
      try {
        const item = entries.get(await codeIndexProjectId(project));
        if (!item) return { state: 'not-ready', files: 0, chunks: 0, symbols: 0, updatedAt: null };
        return { ...item.state };
      } catch { return { state: 'error', error: 'Code index unavailable' }; }
    },
    async stopProject(project) {
      const key = await codeIndexProjectId(project), item = entries.get(key);
      if (!item) return;
      entries.delete(key); await stopWorker(item.worker);
    },
    refresh: (project, options = {}) => readOnly ? Promise.resolve({ state: 'error', error: 'Code index is read-only' }) : call(project, 'refresh', options),
    search: (project, options = {}) => call(project, 'search', options),
    symbols: (project, options = {}) => call(project, 'symbols', options),
    map: (project, options = {}) => call(project, 'map', options),
    async close() {
      closed = true;
      entries.clear();
      const workers = [...liveWorkers];
      liveWorkers.clear();
      await Promise.all(workers.map((worker) => stopWorker(worker)));
    },
  };
}
