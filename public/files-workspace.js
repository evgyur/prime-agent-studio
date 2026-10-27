// Files workspace helpers: history + worktrees tabs (frontend V1).
// Pure functions (unit-tested) plus endpoint URL builders for the confirmed
// backend contract: GET /api/project-git/history, /commit, /commit-diff and
// /api/project-git/worktrees. Fetching, abort guards and rendering stay in
// public/inspector.js so the existing request()/generation guards apply.

export const HISTORY_PAGE_SIZE = 50;

export function historyUrl(cwd, { ref = 'HEAD', offset = 0, limit = HISTORY_PAGE_SIZE } = {}) {
  const params = new URLSearchParams({
    cwd,
    ref,
    offset: String(Math.max(0, offset)),
    limit: String(Math.min(100, Math.max(1, limit))),
  });
  return `/api/project-git/history?${params}`;
}

export function commitUrl(cwd, hash) {
  return `/api/project-git/commit?${new URLSearchParams({ cwd, hash })}`;
}

export function commitDiffUrl(cwd, hash, path) {
  return `/api/project-git/commit-diff?${new URLSearchParams({ cwd, hash, path })}`;
}

export function worktreesUrl(cwd) {
  return `/api/project-git/worktrees?${new URLSearchParams({ cwd })}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

// Normalize the history payload; never throws on malformed data.
export function normalizeHistory(payload) {
  const commits = asArray(payload?.commits).map((entry) => ({
    hash: asString(entry?.hash),
    shortHash: asString(entry?.shortHash) || asString(entry?.hash).slice(0, 7),
    subject: asString(entry?.subject),
    body: asString(entry?.body),
    authorName: asString(entry?.authorName),
    authorEmail: asString(entry?.authorEmail),
    date: asString(entry?.date),
    parents: asArray(entry?.parents).filter((item) => typeof item === 'string'),
    tags: asArray(entry?.tags).filter((item) => typeof item === 'string'),
    branches: asArray(entry?.branches).filter((item) => typeof item === 'string'),
  }));
  return { commits, hasMore: payload?.hasMore === true, ref: asString(payload?.ref) };
}

export function normalizeCommit(payload) {
  const files = asArray(payload?.files).map((entry) => ({
    path: asString(entry?.path),
    oldPath: typeof entry?.oldPath === 'string' ? entry.oldPath : null,
    status: asString(entry?.status) || '?',
    additions: typeof entry?.additions === 'number' ? entry.additions : null,
    deletions: typeof entry?.deletions === 'number' ? entry.deletions : null,
    binary: entry?.binary === true,
  }));
  const stats = payload?.stats && typeof payload.stats === 'object' ? payload.stats : {};
  return {
    hash: asString(payload?.hash),
    subject: asString(payload?.subject),
    body: asString(payload?.body),
    authorName: asString(payload?.authorName),
    date: asString(payload?.date),
    parents: asArray(payload?.parents).filter((item) => typeof item === 'string'),
    tags: asArray(payload?.tags).filter((item) => typeof item === 'string'),
    files,
    stats: {
      files: typeof stats.files === 'number' ? stats.files : files.length,
      additions: typeof stats.additions === 'number' ? stats.additions : 0,
      deletions: typeof stats.deletions === 'number' ? stats.deletions : 0,
    },
  };
}

export function normalizeCommitDiff(payload) {
  return {
    path: asString(payload?.path),
    patch: typeof payload?.patch === 'string' ? payload.patch : '',
    truncated: payload?.truncated === true,
    binary: payload?.binary === true,
  };
}

export function normalizeWorktrees(payload) {
  const worktrees = asArray(payload?.worktrees).map((entry) => ({
    path: asString(entry?.path),
    branch: typeof entry?.branch === 'string' ? entry.branch : null,
    head: asString(entry?.head),
    bare: entry?.bare === true,
    detached: entry?.detached === true,
    locked: entry?.locked === true,
    prunable: entry?.prunable === true,
    isCurrent: entry?.isCurrent === true,
    dirty: typeof entry?.dirty === 'boolean' ? entry.dirty : null,
    managed: entry?.managed === true,
    id: typeof entry?.id === 'string' ? entry.id : null,
  }));
  return { worktrees, currentPath: asString(payload?.currentPath) };
}

// Client-side search over the loaded page: subject, hash, author, tags and
// branch names. tagsOnly keeps commits carrying at least one tag.
export function filterCommits(commits, { search = '', tagsOnly = false } = {}) {
  const needle = search.trim().toLowerCase();
  return asArray(commits).filter((commit) => {
    if (tagsOnly && !asArray(commit?.tags).length) return false;
    if (!needle) return true;
    const haystack = [
      commit?.subject,
      commit?.body,
      commit?.hash,
      commit?.shortHash,
      commit?.authorName,
      ...asArray(commit?.tags),
      ...asArray(commit?.branches),
    ]
      .filter((item) => typeof item === 'string')
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

// Normalized path comparison for worktree identity (OS separators, case,
// trailing slashes). Used to match the registered project root and the
// active Files context without assuming clean state.
export function sameFilesPath(a, b) {
  const normalize = (value) =>
    String(value || '')
      .replaceAll('\\', '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  const left = normalize(a);
  return left !== '' && left === normalize(b);
}

// A worktree entry supports Files-context switching when it is managed or
// it is the registered project root. Anything else (unmanaged foreign paths)
// would fail every follow-up Files/Git call and stays closed.
export function isSupportedFilesWorktree(entry, projectCwd) {
  if (!entry || typeof entry.path !== 'string' || !entry.path) return false;
  if (entry.managed === true) return true;
  return sameFilesPath(entry.path, projectCwd);
}

export function formatCommitDate(iso, locale = 'fr-FR') {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  try {
    return new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(time).toLocaleString();
  }
}

export function formatFileStat(file) {
  if (file?.binary) return 'binary';
  const additions = typeof file?.additions === 'number' ? file.additions : null;
  const deletions = typeof file?.deletions === 'number' ? file.deletions : null;
  if (additions === null || deletions === null) return '';
  return `+${additions} −${deletions}`;
}
