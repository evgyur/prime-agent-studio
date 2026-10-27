// Git panel service for the Files tab (branch, commit, pull, push).
// Only fast-forward pull and plain push are used; push never forces.
// Commit and push RUN the repository hooks. Switch, pull, fetch and status
// DISABLE hooks through an empty hooks dir (same pattern as lib/git-align.mjs).
// Switch never discards work: git itself refuses when local changes would be
// overwritten, and that refusal surfaces as HTTP 409. All git commands run via
// execFile (no shell) with prompting disabled (GIT_TERMINAL_PROMPT=0).
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitBaseEnv } from './worktrees.mjs';
import { HttpError } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const exec = promisify(execFile);
const BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const LOCAL_TIMEOUT = 30_000;
const REMOTE_TIMEOUT = 120_000;
const SUMMARY_LIMIT = 2000;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHORT_SHA_RE = /^[0-9a-f]{4,39}$/i;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HISTORY_LIMIT_MAX = 100;
const COMMIT_FILES_MAX = 500;
const PATCH_MAX_BYTES = 128 * 1024;
const BLOCKED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.codex-remote-attachments',
  '__pycache__',
]);

const stderrOf = (error) => String(error?.stderr || '').trim();
// Selected paths are literal file names, never git pathspec magic:
// a file named "[ab].txt" must not stage or commit "a.txt".
const literal = (value) => `:(literal)${value}`;
const firstLine = (value, max) => String(value || '').split('\n')[0].slice(0, max);

// Infrastructure failures shared by every operation: missing git, timeouts,
// oversized output, or an HttpError that is already translated (store lookup).
function infraError(error) {
  if (error?.status) return error;
  if (error?.code === 'ENOENT') return new HttpError(500, tr('git.panel_no_git'));
  if (error?.killed)
    return new HttpError(504, tr('server.git_met_trop_de_temps_a_repondre_reessayez'));
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return new HttpError(413, tr('server.le_resultat_git_est_trop_volumineux'));
  return null;
}

function validBranch(name) {
  if (typeof name !== 'string') return false;
  const branch = name.trim();
  if (!branch || !BRANCH_RE.test(branch)) return false;
  if (
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    branch.includes('@{')
  )
    return false;
  return true;
}

export function createProjectGit({ store, filesFor, dataDir, resolveProject, protectedRoots }) {
  // Managed task worktrees resolve through the injected resolver (server maps
  // them via resolveWorktreeFileRoot); direct calls fall back to the store.
  const findProject =
    typeof resolveProject === 'function' ? resolveProject : ((cwd) => store.findProject(cwd));
  const guardedRoots = Array.isArray(protectedRoots) ? protectedRoots : [];
  const resolveCwd = async (cwd) => (await findProject(cwd)).cwd;
  const hooksRoot = dataDir || join(tmpdir(), 'prime-agent-studio');
  let hooksReady = null;
  const hooksDir = () => {
    hooksReady ??= mkdir(join(hooksRoot, 'git-nohooks'), { recursive: true }).then(() =>
      join(hooksRoot, 'git-nohooks'),
    );
    return hooksReady;
  };
  const run = async (cwd, args, { hooks = false, timeout = LOCAL_TIMEOUT } = {}) => {
    const head = hooks
      ? ['-c', 'submodule.recurse=false']
      : [
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          '-c',
          `core.hooksPath=${(await hooksDir()).replace(/\\/g, '/')}`,
          '-c',
          'submodule.recurse=false',
        ];
    try {
      const { stdout } = await exec('git', [...head, ...args], {
        cwd,
        windowsHide: true,
        shell: false,
        timeout,
        maxBuffer: 4 << 20,
        env: gitBaseEnv(),
      });
      return String(stdout);
    } catch (error) {
      throw infraError(error) || error;
    }
  };
  const plain = (cwd, args, options) => run(cwd, args, { hooks: true, ...(options || {}) });
  const quiet = (cwd, args, options) => run(cwd, args, { hooks: false, ...(options || {}) });
  const exists = async (cwd, ref) => {
    try {
      await quiet(cwd, ['show-ref', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  };
  const upstreamOf = async (cwd) => {
    try {
      const upstream = (
        await quiet(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      ).trim();
      return upstream || null;
    } catch {
      return null;
    }
  };
  const countsOf = async (cwd) => {
    try {
      const raw = (await quiet(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']))
        .trim()
        .split(/\s+/);
      return { ahead: Number(raw[0]) || 0, behind: Number(raw[1]) || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  };
  const remoteError = (error) =>
    new HttpError(
      409,
      tr('git.panel_remote_failed', {
        value1: stderrOf(error).slice(0, SUMMARY_LIMIT) || firstLine(error?.message, 200),
      }),
    );

  async function status(cwd) {
    const project = await findProject(cwd);
    const root = project.cwd;
    try {
      await quiet(root, ['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      if (error?.status) throw error;
      if (error?.code === 'ENOENT') throw new HttpError(500, tr('git.panel_no_git'));
      return { git: false, reason: tr('server.ce_projet_n_est_pas_un_depot_git') };
    }
    const branch = (await quiet(root, ['branch', '--show-current'])).trim() || null;
    let head = null;
    try {
      head = (await quiet(root, ['rev-parse', 'HEAD'])).trim() || null;
    } catch {
      head = null;
    }
    const upstream = await upstreamOf(root);
    const { ahead, behind } = upstream ? await countsOf(root) : { ahead: 0, behind: 0 };
    let remote = false;
    try {
      await quiet(root, ['remote', 'get-url', 'origin']);
      remote = true;
    } catch {
      remote = false;
    }
    const dirty =
      (await quiet(root, ['status', '--porcelain', '--', '.'])).trim() !== '';
    const local = (await quiet(root, ['branch', '--format=%(refname:short)']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const remoteBranches = (await quiet(root, ['branch', '-r', '--format=%(refname:short)']))
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith('origin/') &&
          line !== 'origin/HEAD' &&
          !line.includes('->') &&
          line.slice('origin/'.length),
      )
      .map((line) => line.slice('origin/'.length));
    return {
      git: true,
      branch,
      head,
      upstream,
      ahead,
      behind,
      remote,
      dirty,
      branches: { local, remote: remoteBranches },
    };
  }

  async function ensureRepo(root) {
    try {
      await quiet(root, ['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      if (error?.status) throw error;
      if (error?.code === 'ENOENT') throw new HttpError(500, tr('git.panel_no_git'));
      throw new HttpError(409, tr('git.align_not_repo'));
    }
  }

  async function fetch(cwd) {
    const project = await findProject(cwd);
    await ensureRepo(project.cwd);
    try {
      await quiet(project.cwd, ['fetch', '--prune', 'origin'], { timeout: REMOTE_TIMEOUT });
    } catch (error) {
      if (error?.status) throw error;
      throw remoteError(error);
    }
    return status(project.cwd);
  }

  async function switchBranch(cwd, { branch, create } = {}) {
    const project = await findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    const name = typeof branch === 'string' ? branch.trim() : '';
    if (!validBranch(name)) throw new HttpError(400, tr('git.panel_bad_branch'));
    let args;
    if (await exists(root, `refs/heads/${name}`)) args = ['switch', name];
    else if (await exists(root, `refs/remotes/origin/${name}`))
      args = ['switch', '--track', '-c', name, `origin/${name}`];
    else if (create) args = ['switch', '-c', name];
    else throw new HttpError(404, tr('git.panel_bad_branch'));
    try {
      await quiet(root, args);
    } catch (error) {
      if (error?.status) throw error;
      if (/would be overwritten|local changes/i.test(stderrOf(error)))
        throw new HttpError(409, tr('git.panel_switch_dirty'));
      throw new HttpError(
        409,
        tr('git.panel_switch_failed', {
          value1: stderrOf(error).slice(0, 500) || firstLine(error?.message, 200),
        }),
      );
    }
    return status(root);
  }

  async function commit(cwd, { message, paths } = {}) {
    const project = await findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    if (typeof message !== 'string' || !message.trim())
      throw new HttpError(400, tr('git.panel_commit_message'));
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((path) => typeof path !== 'string' || !path)
    )
      throw new HttpError(400, tr('git.panel_commit_paths'));
    const wanted = [...new Set(paths)];
    const changes = await filesFor(root).changes(root);
    if (!changes.git) throw new HttpError(409, tr('git.align_not_repo'));
    const listed = new Set(changes.entries.map((entry) => entry.path));
    if (!wanted.every((path) => listed.has(path)))
      throw new HttpError(400, tr('git.panel_commit_paths'));
    const stagedBefore = new Set(
      changes.entries.filter((entry) => entry.staged).map((entry) => entry.path),
    );
    const restoreIndex = async () => {
      const added = wanted.filter((path) => !stagedBefore.has(path));
      if (!added.length) return;
      try {
        await quiet(root, ['reset', '-q', 'HEAD', '--', ...added.map(literal)]);
      } catch {
        /* Best effort: the commit error below stays the reported failure. */
      }
    };
    try {
      await plain(root, ['add', '--', ...wanted.map(literal)]);
    } catch (error) {
      if (!error?.status) await restoreIndex();
      if (error?.status) throw error;
      throw new HttpError(
        409,
        tr('git.panel_commit_failed', {
          value1: stderrOf(error).slice(0, SUMMARY_LIMIT) || firstLine(error?.message, 200),
        }),
      );
    }
    try {
      // Selected files only: the pathspec keeps unrelated pre-staged files out
      // of this commit (plain `git commit` would include them).
      await plain(root, ['commit', '-m', message, '--', ...wanted.map(literal)], {
        timeout: REMOTE_TIMEOUT,
      });
    } catch (error) {
      if (!error?.status) await restoreIndex();
      if (error?.status) throw error;
      throw new HttpError(
        409,
        tr('git.panel_commit_failed', {
          value1: stderrOf(error).slice(0, SUMMARY_LIMIT) || firstLine(error?.message, 200),
        }),
      );
    }
    const sha = (await quiet(root, ['rev-parse', 'HEAD'])).trim();
    const summary = (await quiet(root, ['show', '--stat', '--oneline', 'HEAD', '--']))
      .trim()
      .slice(0, SUMMARY_LIMIT);
    return { ok: true, commit: sha, summary, status: await status(root) };
  }

  async function pull(cwd) {
    const project = await findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    if (!(await upstreamOf(root))) throw new HttpError(409, tr('git.panel_no_upstream'));
    try {
      await quiet(root, ['pull', '--ff-only'], { timeout: REMOTE_TIMEOUT });
    } catch (error) {
      if (error?.status) throw error;
      const stderr = stderrOf(error);
      if (/not possible to fast-forward|divergent|have diverged/i.test(stderr))
        throw new HttpError(409, tr('git.panel_pull_diverged'));
      const { ahead, behind } = await countsOf(root);
      if (ahead > 0 && behind > 0) throw new HttpError(409, tr('git.panel_pull_diverged'));
      if (/local changes.*would be overwritten/i.test(stderr))
        throw new HttpError(409, tr('git.panel_local_changes'));
      throw remoteError(error);
    }
    return status(root);
  }

  async function push(cwd) {
    const project = await findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    const branch =
      (await quiet(root, ['branch', '--show-current']).catch(() => '')).trim() || null;
    const upstream = await upstreamOf(root);
    const args = upstream ? ['push'] : branch ? ['push', '-u', 'origin', branch] : ['push'];
    try {
      await plain(root, args, { timeout: REMOTE_TIMEOUT });
    } catch (error) {
      if (error?.status) throw error;
      if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(stderrOf(error)))
        throw new HttpError(409, tr('git.panel_push_rejected'));
      throw remoteError(error);
    }
    return status(root);
  }


  // ---- Read-only history / commit / worktree APIs (Files redesign) ----
  // All reads run with hooks disabled (quiet) and never invoke external
  // diff drivers or textconv. Bounded output and time on every call.

  const checkArg = (arg) => {
    if (typeof arg !== 'string' || arg.includes('\0'))
      throw new HttpError(400, tr('server.valeur_invalide'));
  };

  const parsePaging = ({ offset, limit } = {}) => {
    const toInt = (value, fallback) => {
      if (value === undefined || value === null || value === '') return fallback;
      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isSafeInteger(parsed)) throw new HttpError(400, tr('server.page_invalide'));
      return parsed;
    };
    const skip = toInt(offset, 0);
    let take = toInt(limit, 50);
    if (skip < 0 || skip > 1000000) throw new HttpError(400, tr('server.page_invalide'));
    if (take < 1) throw new HttpError(400, tr('server.page_invalide'));
    if (take > HISTORY_LIMIT_MAX) take = HISTORY_LIMIT_MAX;
    return { skip, take };
  };

  async function resolveRef(root, ref) {
    const name = ref === undefined || ref === null || ref === '' ? 'HEAD' : String(ref).trim();
    const ok = name === 'HEAD' || FULL_SHA_RE.test(name) || SHORT_SHA_RE.test(name) || validBranch(name);
    if (!ok || name.length > 220) throw new HttpError(400, tr('git.panel_bad_branch'));
    try {
      const sha = (await quiet(root, ['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`])).trim();
      if (!FULL_SHA_RE.test(sha)) throw new Error('bad sha');
      return sha;
    } catch (error) {
      if (error?.status) throw error;
      throw new HttpError(404, tr('git.panel_bad_branch'));
    }
  }

  async function checkCommitHash(root, hash) {
    if (typeof hash !== 'string' || !FULL_SHA_RE.test(hash.trim()))
      throw new HttpError(400, tr('git.panel_bad_branch'));
    const sha = hash.trim().toLowerCase();
    try {
      await quiet(root, ['cat-file', '-e', `${sha}^{commit}`]);
    } catch (error) {
      if (error?.status) throw error;
      throw new HttpError(404, tr('git.panel_bad_branch'));
    }
    return sha;
  }

  function checkCommitPath(root, path) {
    if (typeof path !== 'string' || !path || path.length > 1024 || /[\x00-\x1f]/.test(path))
      throw new HttpError(400, tr('server.chemin_de_fichier_invalide'));
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\'))
      throw new HttpError(400, tr('server.chemin_de_fichier_invalide'));
    const parts = path.split('/');
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.endsWith('.') ||
          part.endsWith(' ') ||
          part.includes(':'),
      )
    )
      throw new HttpError(400, tr('server.chemin_de_fichier_invalide'));
    if (parts.some((part) => BLOCKED_SEGMENTS.has(part.toLowerCase())))
      throw new HttpError(
        403,
        tr('server.ce_chemin_n_est_pas_accessible_dans_les_fichiers_du_projet'),
      );
    for (const guarded of guardedRoots) {
      if (typeof guarded !== 'string' || !guarded) continue;
      const prefix = guarded.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      const candidate = `${root.replace(/\\/g, '/')}/${path}`.toLowerCase();
      if (candidate === prefix || candidate.startsWith(`${prefix}/`))
        throw new HttpError(
          403,
          tr('server.ce_dossier_contient_les_donnees_privees_du_moteur_ou_du_studio'),
        );
    }
    return path;
  }

  function truncatePatch(text) {
    const total = Buffer.byteLength(text, 'utf8');
    if (total <= PATCH_MAX_BYTES) return { text, truncated: false };
    let cut = Buffer.from(text, 'utf8').subarray(0, PATCH_MAX_BYTES).toString('utf8');
    const last = cut.lastIndexOf('\n');
    if (last > 0) cut = cut.slice(0, last);
    return { text: `${cut}\n... [truncated at ${PATCH_MAX_BYTES} bytes]`, truncated: true };
  }

  async function batchCommits(root, hashes) {
    // One read-only process per commit through the shared quiet helper:
    // execFile stdin hangs on some Windows setups, so no --batch input.
    if (hashes.length === 0) return new Map();
    const settled = await Promise.all(
      hashes.map(async (hash) => {
        try {
          checkArg(hash);
          const content = await quiet(root, ['cat-file', 'commit', hash]);
          return [hash, parseCommitObject(content)];
        } catch {
          return [hash, null];
        }
      }),
    );
    return new Map(settled.filter(([, parsed]) => parsed));
  }

  function parseCommitObject(content) {
    const split = content.indexOf('\n\n');
    const headerText = split < 0 ? content : content.slice(0, split);
    const message = split < 0 ? '' : content.slice(split + 2);
    const parents = [];
    let authorName = '';
    let authorEmail = '';
    let date = null;
    for (const line of headerText.split('\n')) {
      if (line.startsWith('parent ')) {
        const sha = line.slice(7).trim();
        if (FULL_SHA_RE.test(sha)) parents.push(sha.toLowerCase());
      } else if (line.startsWith('author ')) {
        const match = line.slice(7).match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
        if (match) {
          authorName = match[1].trim();
          authorEmail = match[2].trim();
          const millis = Number.parseInt(match[3], 10) * 1000;
          if (Number.isSafeInteger(millis)) date = new Date(millis).toISOString();
        } else {
          authorName = line.slice(7).trim();
        }
      }
    }
    const cut = message.indexOf('\n');
    const subject = (cut < 0 ? message : message.slice(0, cut)).trim();
    const body = (cut < 0 ? '' : message.slice(cut + 1).replace(/^\n+/, '')).slice(0, 4000);
    return { parents, authorName, authorEmail, date, subject, body };
  }

  async function refsPointingAt(root) {
    const byCommit = new Map();
    const add = (sha, kind, name) => {
      if (!FULL_SHA_RE.test(sha)) return;
      const key = sha.toLowerCase();
      if (!byCommit.has(key)) byCommit.set(key, { branches: [], tags: [] });
      const entry = byCommit.get(key);
      if (kind === 'branch') {
        if (name !== 'origin/HEAD' && !name.includes('->') && !entry.branches.includes(name))
          entry.branches.push(name);
      } else if (!entry.tags.includes(name)) entry.tags.push(name);
    };
    try {
      const heads = await quiet(root, [
        'for-each-ref',
        '--format=%(objectname) %(refname:short)',
        'refs/heads',
        'refs/remotes',
      ]);
      for (const line of heads.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const space = trimmed.indexOf(' ');
        if (space < 0) continue;
        let name = trimmed.slice(space + 1).trim();
        if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
        add(trimmed.slice(0, space), 'branch', name);
      }
    } catch {
      /* best effort: history still works without branch labels */
    }
    try {
      const tags = await quiet(root, [
        'for-each-ref',
        '--format=%(objectname) %(*objectname) %(refname:short)',
        'refs/tags',
      ]);
      for (const line of tags.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(' ');
        if (parts.length < 3) continue;
        add(parts[1] || parts[0], 'tag', parts.slice(2).join(' '));
      }
    } catch {
      /* best effort: history still works without tag labels */
    }
    return byCommit;
  }

  async function history(cwd, { ref, offset, limit } = {}) {
    const root = await resolveCwd(cwd);
    await ensureRepo(root);
    const { skip, take } = parsePaging({ offset, limit });
    const resolved = await resolveRef(root, ref);
    const listed = (
      await quiet(root, [
        'rev-list',
        `--skip=${skip}`,
        `--max-count=${take + 1}`,
        resolved,
      ])
    )
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => FULL_SHA_RE.test(line));
    const hasMore = listed.length > take;
    const hashes = listed.slice(0, take);
    const [objects, refs] = await Promise.all([batchCommits(root, hashes), refsPointingAt(root)]);
    const commits = hashes.map((hash) => {
      const parsed = objects.get(hash) || { parents: [], authorName: '', authorEmail: '', date: null, subject: '', body: '' };
      const labels = refs.get(hash) || { branches: [], tags: [] };
      return {
        hash,
        shortHash: hash.slice(0, 7),
        subject: parsed.subject,
        body: parsed.body,
        authorName: parsed.authorName,
        authorEmail: parsed.authorEmail,
        date: parsed.date,
        parents: parsed.parents,
        tags: labels.tags,
        branches: labels.branches,
      };
    });
    return { commits, hasMore, ref: resolved };
  }

  function parseNumstat(out) {
    // NUL-safe numstat: rename rows carry an empty name field followed by
    // old then new path; older gits repeat old in the name field.
    const tokens = String(out).split('\0').filter((token) => token.length > 0);
    const rows = [];
    for (let i = 0; i < tokens.length && rows.length < 4000; i++) {
      const token = tokens[i];
      if (!token.includes('\t')) continue;
      const parts = token.split('\t');
      if (parts.length < 3) continue;
      let name = parts.slice(2).join('\t');
      let oldPath = null;
      if (name === '') {
        oldPath = tokens[i + 1];
        name = tokens[i + 2];
        i += 2;
      } else if (i + 1 < tokens.length && !tokens[i + 1].includes('\t')) {
        oldPath = name;
        name = tokens[i + 1];
        i += 1;
      }
      if (typeof name !== 'string' || !name || name.includes('\0')) continue;
      const binary = parts[0] === '-' && parts[1] === '-';
      rows.push({
        path: name,
        oldPath,
        additions: binary ? null : Number.parseInt(parts[0], 10) || 0,
        deletions: binary ? null : Number.parseInt(parts[1], 10) || 0,
        binary,
      });
    }
    return rows;
  }

  function parseNameStatus(out) {
    const tokens = String(out).split('\0').filter((token) => token.length > 0);
    const rows = [];
    for (let i = 0; i < tokens.length && rows.length < 4000; i++) {
      const token = tokens[i];
      if (!token || token.includes('\t') || token.includes('\n')) continue;
      const status = token[0] || '?';
      const next = tokens[i + 1];
      if (typeof next !== 'string' || !next || next.includes('\0') || next.includes('\t')) continue;
      if (status === 'R' || status === 'C') {
        const target = tokens[i + 2];
        if (typeof target !== 'string' || !target || target.includes('\0') || target.includes('\t')) continue;
        rows.push({ status, path: target, oldPath: next });
        i += 2;
      } else {
        rows.push({ status, path: next, oldPath: null });
        i += 1;
      }
    }
    return rows;
  }

  async function commitFiles(root, hash, parents) {
    const base = parents[0] || EMPTY_TREE;
    const args = (mode) => [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      mode,
      '-z',
      '--find-renames',
      base,
      hash,
      '--',
    ];
    const [numstatOut, nameOut] = await Promise.all([
      quiet(root, args('--numstat')),
      quiet(root, args('--name-status')),
    ]);
    const counts = new Map(parseNumstat(numstatOut).map((row) => [row.path, row]));
    const files = [];
    let additions = 0;
    let deletions = 0;
    for (const entry of parseNameStatus(nameOut)) {
      const count = counts.get(entry.path);
      const binary = count ? count.binary : false;
      // Rename rows keyed by old path on older gits: fall back to entry path.
      const added = count && !binary ? count.additions : 0;
      const removed = count && !binary ? count.deletions : 0;
      additions += added;
      deletions += removed;
      if (files.length < COMMIT_FILES_MAX) {
        files.push({
          path: entry.path,
          ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
          status: entry.status,
          additions: binary ? null : added,
          deletions: binary ? null : removed,
          binary,
        });
      }
    }
    return { files, stats: { files: parseNameStatus(nameOut).length, additions, deletions } };
  }

  async function commitInfo(cwd, hash) {
    const root = await resolveCwd(cwd);
    await ensureRepo(root);
    const sha = await checkCommitHash(root, hash);
    const parsed = (await batchCommits(root, [sha])).get(sha);
    if (!parsed) throw new HttpError(404, tr('git.panel_bad_branch'));
    let tags = [];
    try {
      tags = (await quiet(root, ['tag', '--points-at', sha]))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 100);
    } catch {
      tags = [];
    }
    const { files, stats } = await commitFiles(root, sha, parsed.parents);
    return {
      hash: sha,
      subject: parsed.subject,
      body: parsed.body,
      authorName: parsed.authorName,
      date: parsed.date,
      parents: parsed.parents,
      tags,
      files,
      stats,
    };
  }

  async function commitDiff(cwd, hash, path) {
    const root = await resolveCwd(cwd);
    await ensureRepo(root);
    const sha = await checkCommitHash(root, hash);
    const wanted = checkCommitPath(root, path);
    const parentsLine = (await quiet(root, ['rev-list', '--parents', '-n', '1', sha])).trim();
    const parts = parentsLine.split(/\s+/);
    const base = parts.length > 1 && FULL_SHA_RE.test(parts[1]) ? parts[1].toLowerCase() : EMPTY_TREE;
    const statusOut = await quiet(root, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--name-status',
      '-z',
      '--find-renames',
      base,
      sha,
      '--',
    ]);
    const entry = parseNameStatus(statusOut).find(
      (row) => row.path === wanted || row.oldPath === wanted,
    );
    if (!entry) throw new HttpError(404, tr('server.fichier_introuvable'));
    const literal = (value) => `:(literal)${value}`;
    const scope =
      entry.oldPath && entry.oldPath !== entry.path
        ? ['--', literal(entry.oldPath), literal(entry.path)]
        : ['--', literal(entry.path)];
    const numstatOut = await quiet(root, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--numstat',
      '-z',
      '--find-renames',
      base,
      sha,
      ...scope,
    ]);
    const row = parseNumstat(numstatOut)[0];
    if (row && row.binary) return { path: entry.path, patch: '', truncated: false, binary: true };
    const patch = await quiet(root, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--unified=3',
      '--find-renames',
      base,
      sha,
      ...scope,
    ]);
    const cut = truncatePatch(patch);
    return { path: entry.path, patch: cut.text, truncated: cut.truncated, binary: false };
  }

  const DIRTY_TIMEOUT_MS = 8_000;
  const DIRTY_CHECK_MAX = 10;
  const normalizeWorktreePath = (value) => {
    try {
      const resolved = resolve(String(value));
      if (typeof resolved === 'string' && resolved) return resolved;
    } catch {
      /* keep raw git output */
    }
    return value;
  };
  async function nativeWorktrees(cwd, { isManaged } = {}) {
    const root = await resolveCwd(cwd);
    await ensureRepo(root);
    const porcelain = await quiet(root, ['worktree', 'list', '--porcelain', '-z']);
    const grouped = [];
    let current = null;
    for (const token of String(porcelain).split('\0')) {
      const line = token.replace(/\n$/, '');
      if (!line) {
        if (current) {
          grouped.push(current);
          current = null;
        }
        continue;
      }
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      if (key === 'worktree') {
        if (current) grouped.push(current);
        current = { path: value };
      } else if (current) {
        if (key === 'HEAD') current.head = FULL_SHA_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
        else if (key === 'branch') {
          const ref = value.trim();
          current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        } else if (key === 'detached') current.detached = true;
        else if (key === 'bare') current.bare = true;
        else if (key === 'locked') current.locked = true;
        else if (key === 'prunable') current.prunable = true;
      }
    }
    if (current) grouped.push(current);
    let currentPath = root;
    try {
      currentPath = (await quiet(root, ['rev-parse', '--show-toplevel'])).trim() || root;
    } catch {
      currentPath = root;
    }
    currentPath = normalizeWorktreePath(currentPath);
    const keyOf = (value) => String(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const currentKey = keyOf(currentPath);
    const worktrees = [];
    for (const entry of grouped.slice(0, 100)) {
      if (!entry.path) continue;
      const absolute = normalizeWorktreePath(entry.path);
      const isCurrent = keyOf(absolute) === currentKey;
      worktrees.push({
        path: absolute,
        branch: entry.detached || entry.bare ? null : entry.branch || null,
        head: entry.head || null,
        bare: entry.bare === true,
        detached: entry.detached === true,
        locked: entry.locked === true,
        prunable: entry.prunable === true,
        isCurrent,
      });
    }
    // Dirty is only probed on the current worktree and verified managed
    // entries: never run status across arbitrary unmanaged roots. Short
    // bounded checks in parallel; anything else stays unknown to the UI.
    const checkable = [];
    for (const item of worktrees) {
      if (item.bare || checkable.length >= DIRTY_CHECK_MAX) continue;
      if (item.isCurrent) {
        checkable.push(item);
        continue;
      }
      if (typeof isManaged === 'function') {
        try {
          if (await isManaged(item.path)) checkable.push(item);
        } catch {
          /* unknown: omit dirty */
        }
      }
    }
    await Promise.all(
      checkable.map(async (item) => {
        try {
          const dirty = await quiet(item.path, ['status', '--porcelain', '--', '.'], {
            timeout: DIRTY_TIMEOUT_MS,
          });
          item.dirty = dirty.trim() !== '';
        } catch {
          /* unknown: omit dirty */
        }
      }),
    );
    return { worktrees, currentPath };
  }

  return {
    status,
    fetch,
    switchBranch,
    commit,
    pull,
    push,
    history,
    commitInfo,
    commitDiff,
    nativeWorktrees,
    resolveCwd,
  };
}
