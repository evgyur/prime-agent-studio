import { DatabaseSync } from 'node:sqlite';
import { sensitiveCodePath } from './code-context-policy.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch, lstatSync, realpathSync, openSync, closeSync, readFileSync, readdirSync, fstatSync, constants } from 'node:fs';
import { join, relative, isAbsolute, sep, extname, matchesGlob, posix } from 'node:path';
import { setPriority, constants as osConstants } from 'node:os';

try { setPriority(0, osConstants.priority.PRIORITY_LOW); } catch { /* Restricted hosts keep default priority. */ }
const MAX_FILES = 10_000, MAX_BYTES = 64 * 1024 * 1024, MAX_FILE = 1024 * 1024;
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.cs', '.rs', '.go', '.json', '.md', '.html', '.css', '.sql', '.toml', '.yaml', '.yml', '.sh', '.ps1', '.vue', '.svelte']);
const MANIFESTS = new Set(['Makefile', 'GNUmakefile', 'Dockerfile', 'Justfile', 'justfile', 'go.mod', 'go.sum']);
const inside = (root, path) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
let db, reader, root, watcher, timer, exclusions = [], closed = false, readOnly = false, scanEnabled = false, includeGenerated = false;
let state = { state: 'not-ready', files: 0, chunks: 0, updatedAt: null };
const update = () => { if (process.connected) process.send({ event: 'update', status: state }); };
const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const limitOf = (limit) => Math.min(50, Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 10));
function exclusionReason(path) {
  if (typeof path !== 'string' || path.length >= 1000 || path.includes('\\') || path.split('/').includes('..') || isAbsolute(path)) return 'unsafe';
  if (sensitiveCodePath(path)) return 'sensitive-name';
  if (exclusions.some((pattern) => matchesGlob(path, pattern) || path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`))) return 'configured';
  if (!includeGenerated && /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i.test(path)) return 'lockfile';
  if (!includeGenerated && /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|\.next|generated|__generated__)(?:\/|$)|(?:\.min\.(?:js|css)|\.generated\.[^/]+|\.map)$/i.test(path)) return 'generated';
  if (/(^|\/)\.git(\/|$)/.test(path)) return 'unsafe';
  if (!EXTENSIONS.has(extname(path).toLowerCase()) && !MANIFESTS.has(posix.basename(path)) && !/\.lock$/i.test(path)) return 'unsupported';
  return null;
}
const allowed = (path) => !exclusionReason(path);
function redact(text, path) {
  // Redact values, never expression references such as apiKey: value.credentialEnv.
  const key = '(?:api[_-]?key|password|secret|access[_-]?token|private[_-]?key|authorization)';
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, (value) => value.replace(/[^\n]/g, '*'))
    .replace(new RegExp(`(${key}["']?\\s*[:=]\\s*)(["'\\x60])([^\\n]*?)\\2`, 'gi'), (all, prefix, quote, value) => value.length > 0 && !value.includes('${') && !/^(?:example|placeholder|your[-_ ]|<|Bearer$)/i.test(value) ? `${prefix}${quote}[REDACTED]${quote}` : all)
    .replace(/([:=]\s*)(["'])([A-Za-z0-9+/_=-]{24,})\2/g, (all, prefix, quote, value) => /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value) && new Set(value).size >= 16 ? `${prefix}${quote}[REDACTED]${quote}` : all)
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(new RegExp(`(^[ \\t]*${key}\\s*:\\s*)([^\\s"'{}]+)`, 'gim'), (all, prefix, value) => /\.(?:ya?ml|toml)$/i.test(path) && !/^(?:null|true|false|\$|<)/.test(value) ? `${prefix}[REDACTED]` : all);
}

const COMMON_REFERENCES = new Set('slice map get set has add delete filter find includes push pop shift unshift forEach reduce sort join split replace replaceAll trim toString stringify parse resolve reject then catch finally all keys values entries assign freeze now log warn error test match exec charAt startsWith endsWith substring substr indexOf lastIndexOf some every flat flatMap from isArray Number String Boolean Object Array Promise Set Map Date Error RegExp JSON Math require'.split(' '));
function source(path) {
  if (!allowed(path)) return null;
  const full = join(root, path);
  // Refuse every symlink component, including links that currently resolve inside the root.
  let cursor = root;
  for (const part of path.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) return { excludedReason: 'unsafe' }; }
  if (!inside(root, realpathSync(full))) return { excludedReason: 'unsafe' };
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (stat.size > MAX_FILE) return { excludedReason: 'too-large' };
    if (!stat.isFile() || stat.nlink > 1 || !inside(root, realpathSync(full))) return { excludedReason: 'unsafe' };
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_FILE) return { excludedReason: 'too-large' };
    if (bytes.includes(0)) return { excludedReason: 'binary' };
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { excludedReason: 'binary' }; }
    return { text: redact(text, path), size: stat.size, mtime: stat.mtimeMs, hash: hash(bytes) };
  } finally { closeSync(fd); }
}
function extract(text) {
  const lines = text.split('\n'), definitions = [], references = [], imports = [], importLines = new Set();
  // ponytail: bounded lexical extraction; no compiler resolution or new dependency.
  const importPattern = /^\s*(?:import\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s*)?|export\s+(?:type\s+)?[\w$*{},\s]+?\s+from\s*|(?:const|let|var)\s+[^;\n]+?=\s*require\s*\(\s*)["']([^"']+)["'][^\n]*/gm;
  for (const match of text.matchAll(importPattern)) {
    const line = text.slice(0, match.index).split('\n').length;
    imports.push({ line, text: match[0].trim().slice(0, 500), target: match[1] });
    for (let i = line; i < line + match[0].split('\n').length; i++) importLines.add(i);
  }
  const definition = /\b(?:class|interface|struct|enum|trait|type|def|fn|func|function)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|sealed)\s+)+(?:[\w<>?\[\],]+\s+)([A-Za-z_$][\w$]*)\s*\(/;
  const controls = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'with', 'function']);
  for (let i = 0; i < lines.length && i < 30_000; i++) {
    const line = lines[i];
    if (importLines.has(i + 1)) continue;
    const match = line.match(definition);
    let name = match && (match[1] || match[2] || match[3]);
    if (!name) name = line.match(/^\s*(?:(?:public|private|protected|static|readonly)\s+)*(#?[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/)?.[1];
    if (!name) {
      const method = line.match(/^\s*(?:(?:public|private|protected|static|async|override|abstract|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^;=]+>)?\s*\(/);
      if (method && !controls.has(method[1])) {
        const signature = lines.slice(i, i + 20).join('\n').slice(method[0].length - 1);
        let depth = 0, end = -1;
        for (let j = 0; j < signature.length; j++) {
          if (signature[j] === '(') depth++;
          if (signature[j] === ')' && --depth === 0) { end = j; break; }
        }
        if (end >= 0 && /^\s*(?::[^;=\n]+)?\s*\{/.test(signature.slice(end + 1))) name = method[1];
      }
    }
    if (name) definitions.push({ name, kind: 'definition', line: i + 1 });
    if (/^\s*(?:from\s+\S+\s+import\b|import\s+[\w.]+\s*$|using\b|use\b)/.test(line)) imports.push({ line: i + 1, text: line.trim().slice(0, 500), target: line.match(/(?:from|import|using|use)\s+([\w.:/]+)/)?.[1] || null });
    if (references.length < 10_000) for (const token of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (token[1] !== name?.replace(/^#/, '') && !controls.has(token[1])) references.push({ name: token[1], kind: 'reference', line: i + 1 });
    }
  }
  return { definitions: definitions.slice(0, 2000), references: references.slice(0, 10_000), imports: imports.slice(0, 500) };
}
function refresh(options = {}) {
  if (!db) return state;
  scanEnabled = true;
  if (Array.isArray(options.exclusions)) exclusions = options.exclusions.filter((v) => typeof v === 'string' && v.length <= 300).slice(0, 100);
  if (typeof options.includeGenerated === 'boolean') includeGenerated = options.includeGenerated;
  state = { ...state, state: 'indexing', progress: undefined, error: undefined }; update();
  try {
    // Live file list with readdir fallback when Git is briefly unavailable.
    const discovered = freshFileList();
    const rejected = discovered.map((path) => ({ path, reason: exclusionReason(path) })).filter((row) => row.reason);
    const paths = discovered.filter(allowed).slice(0, MAX_FILES);
    state = { ...state, progress: { completed: 0, total: paths.length } }; update();
    const seen = new Set(); let bytes = 0, changed = 0, completed = 0;
    const putFile = db.prepare('INSERT OR REPLACE INTO files(path,mtime,size,hash,imports) VALUES(?,?,?,?,?)');
    const putSymbol = db.prepare('INSERT INTO symbols(path,name,kind,line) VALUES(?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (options.rebuild) db.exec('DELETE FROM files; DELETE FROM symbols');
      for (const path of paths) {
        completed++;
        if (completed % 100 === 0) {
          state = { ...state, progress: { completed, total: paths.length } }; update();
        }
        let item; try { item = source(path); } catch { rejected.push({ path, reason: 'unsafe' }); continue; }
        if (!item || item.excludedReason) { rejected.push({ path, reason: item?.excludedReason || 'unsafe' }); continue; }
        bytes += item.size; if (bytes > MAX_BYTES) break;
        seen.add(path);
        const old = db.prepare('SELECT mtime,size,hash FROM files WHERE path=?').get(path);
        if (old && old.hash === item.hash) {
          if (old.mtime !== item.mtime || old.size !== item.size) db.prepare('UPDATE files SET mtime=?,size=? WHERE path=?').run(item.mtime, item.size, path);
          continue;
        }
        const parsed = extract(item.text);
        db.prepare('DELETE FROM symbols WHERE path=?').run(path);
        putFile.run(path, item.mtime, item.size, item.hash, JSON.stringify(parsed.imports));
        for (const symbol of [...parsed.definitions, ...parsed.references]) putSymbol.run(path, symbol.name, symbol.kind, symbol.line);
        changed++;
      }
      for (const { path } of db.prepare('SELECT path FROM files').all()) if (!seen.has(path)) {
        db.prepare('DELETE FROM files WHERE path=?').run(path); db.prepare('DELETE FROM symbols WHERE path=?').run(path); changed++;
      }
      db.exec('DELETE FROM changes');
      try {
        const log = git(['log', '-40', '--format=%x00COMMIT:%H:%ct%x00', '--name-only', '-z', '--no-renames']);
        let commit = '', timestamp = 0;
        const put = db.prepare('INSERT OR IGNORE INTO changes(commitId,path,timestamp) VALUES(?,?,?)');
        for (const raw of log.split('\0')) {
          const token = raw.replace(/^\n+|\n+$/g, '');
          if (token.startsWith('COMMIT:')) { const parts = token.split(':'); commit = parts[1]; timestamp = Number(parts[2]); }
          else if (commit && seen.has(token)) put.run(commit, token, timestamp);
        }
      } catch { /* Empty Git repositories have no history. */ }
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('exclusions', JSON.stringify(exclusions));
      db.exec('DELETE FROM excluded');
      const putExcluded = db.prepare('INSERT OR REPLACE INTO excluded(path,reason) VALUES(?,?)');
      for (const row of rejected) putExcluded.run(row.path, row.reason);
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('includeGenerated', String(includeGenerated));
      const updatedAt = new Date().toISOString();
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('updatedAt', updatedAt);
      db.exec('COMMIT');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      state = { state: 'ready', progress: { completed, total: paths.length }, symbols: db.prepare('SELECT count(*) AS n FROM symbols').get().n, files: seen.size, chunks: 0, updatedAt, changed, bytes, includeGenerated, ...exclusionReport(db), indexedAt: updatedAt, capped: paths.length >= MAX_FILES || bytes > MAX_BYTES };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { state = { ...state, state: 'error', error: 'Local code index refresh failed', detail: error.code || 'INDEX_ERROR' }; }
  update(); return state;
}
function exclusionReport(connection = reader) {
  const rows = connection.prepare('SELECT path,reason FROM excluded ORDER BY path').all();
  const indexed = connection.prepare('SELECT path FROM files ORDER BY path').all();
  for (const { path } of indexed) { const reason = exclusionReason(path); if (reason) rows.push({ path, reason }); }
  return { automaticExclusions: rows.slice(0, 30), excludedCount: rows.length, exclusionsTruncated: rows.length > 30 };
}
function freshness(path) {
  const indexed = reader.prepare('SELECT mtime,size FROM files WHERE path=?').get(path);
  try {
    let cursor = root;
    for (const part of path.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) return true; }
    const stat = lstatSync(cursor);
    // Tolerance for filesystem/SQLite mtime rounding; exact equality falsely flags unchanged files stale.
    return !indexed || !stat.isFile() || stat.nlink > 1 || Math.abs(stat.mtimeMs - indexed.mtime) > 2 || stat.size !== indexed.size;
  } catch { return true; }
}
const PER_FILE_HITS = 3;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isTestPath = (path) => /(^|\/)(test|tests|__tests__|spec)(?:\/|$)|\.(test|spec)\.[a-z]+$/i.test(path);
const isDocPath = (path) => /\.md$/i.test(path) || /(^|\/)README/i.test(path);
const fileKindRank = (path) => (isDocPath(path) ? 2 : isTestPath(path) ? 1 : 0);
function freshFileList() {
  try {
    return [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort().slice(0, MAX_FILES);
  } catch {
    const out = [], stack = [''];
    while (stack.length && out.length < MAX_FILES) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (rel === '.git' || rel.startsWith('.git/')) continue;
        try {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) stack.push(rel);
          else if (entry.isFile() && out.length < MAX_FILES) out.push(rel);
        } catch { /* Skip unreadable entries. */ }
      }
    }
    return out.sort();
  }
}
function classifyHit(path, lineText, lineNum, defLines, importLineSet) {
  if (importLineSet.has(lineNum)) return 'import';
  if (defLines.has(lineNum)) return 'definition';
  if (isTestPath(path)) return 'test';
  if (isDocPath(path)) return 'doc';
  if (/^\s*(\/\/|\/\*|\*|#|--|<!--)/.test(lineText)) return 'comment';
  if (/["'`].*["'`]/.test(lineText)) return 'UI-string';
  return 'reference';
}
function exactHits(raw, flags = {}, max = 10) {
  const q = String(raw || '').slice(0, 500);
  if (!q) return null;
  const smartInsensitive = !/[A-Z]/.test(q);
  let pattern = null;
  if (flags.regex || flags.wholeWord) {
    try {
      pattern = new RegExp(flags.regex ? (flags.wholeWord ? `\\b(?:${q})\\b` : q) : `\\b${escapeRegExp(q)}\\b`, smartInsensitive ? 'gi' : 'g');
    } catch { return { invalid: true, files: 0, hits: 0, omitted: 0, results: [] }; }
  }
  const needle = smartInsensitive ? q.toLowerCase() : q;
  const files = flags.scope ? [flags.scope] : freshFileList();
  let total = 0;
  const seenFiles = new Set(), collected = [];
  for (const file of files) {
    if (!allowed(file)) continue;
    let item = null;
    try { item = source(file); } catch { continue; }
    if (!item || item.excludedReason || typeof item.text !== 'string') continue;
    if (pattern) { pattern.lastIndex = 0; if (!pattern.test(item.text)) continue; }
    else if (smartInsensitive ? !item.text.toLowerCase().includes(needle) : !item.text.includes(q)) continue;
    const lines = item.text.split('\n'), matched = [];
    for (let i = 0; i < lines.length; i++) {
      let hit = false;
      if (pattern) { pattern.lastIndex = 0; hit = pattern.test(lines[i]); }
      else hit = smartInsensitive ? lines[i].toLowerCase().includes(needle) : lines[i].includes(q);
      if (hit) matched.push(i + 1);
    }
    if (!matched.length) continue;
    total += matched.length;
    seenFiles.add(file);
    let parsed = null;
    try { parsed = extract(item.text); } catch { parsed = null; }
    const defLines = new Set((parsed?.definitions || []).map((d) => d.line));
    const importLineSet = new Set((parsed?.imports || []).map((im) => im.line));
    const defs = [...(parsed?.definitions || [])].sort((a, b) => a.line - b.line);
    for (const lineNum of matched.slice(0, PER_FILE_HITS)) {
      const lineText = lines[lineNum - 1];
      const label = classifyHit(file, lineText, lineNum, defLines, importLineSet);
      let enclosing = null;
      for (let d = defs.length - 1; d >= 0; d--) {
        if (defs[d].line <= lineNum) {
          const next = d + 1 < defs.length ? defs[d + 1].line : lines.length + 1;
          enclosing = { name: defs[d].name, signature: lines[defs[d].line - 1].trim().slice(0, 200), startLine: defs[d].line, endLine: next - 1 };
          break;
        }
      }
      collected.push({ path: file, startLine: lineNum, endLine: lineNum, text: String(lineText).slice(0, 500), label, symbol: enclosing, context: { before: lineNum > 1 ? String(lines[lineNum - 2]).slice(0, 300) : null, after: lineNum < lines.length ? String(lines[lineNum]).slice(0, 300) : null }, stale: false, _first: label === 'definition' ? 0 : 1, _kind: fileKindRank(file) });
    }
  }
  collected.sort((a, b) => a._first - b._first || a._kind - b._kind || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
  const results = collected.slice(0, max).map(({ _first, _kind, ...row }) => row);
  return { files: seenFiles.size, hits: total, omitted: Math.max(0, total - results.length), results };
}
function pathExcerpts(scope) {
  let item = null;
  try { item = source(scope); } catch { return []; }
  if (!item || item.excludedReason || typeof item.text !== 'string') return [];
  const rows = [];
  const text = item.text;
  let offset = 0, line = 1;
  while (offset < text.length && rows.length < 500) {
    const stop = Math.min(text.length, offset + 1500);
    const slice = text.slice(offset, stop);
    const newlines = (slice.match(/\n/g) || []).length;
    rows.push({ path: scope, startLine: line, endLine: line + newlines - (slice.endsWith('\n') ? 1 : 0), text: slice, stale: false });
    line += newlines;
    offset = stop;
  }
  if (!rows.length) rows.push({ path: scope, startLine: 1, endLine: 1, text: '', stale: false });
  return rows;
}
function query(method, options) {
  if (state.reason === 'rebuild-required') return { state: 'not-ready', reason: state.reason, indexedAt: null, results: [] };
  const limit = limitOf(options.limit);
  const persistedExclusions = reader ? JSON.parse(reader.prepare("SELECT value FROM meta WHERE key='exclusions'").get()?.value || '[]') : [];
  exclusions = [...persistedExclusions, ...(Array.isArray(options.exclusions) ? options.exclusions.filter((value) => typeof value === 'string' && value.length <= 300).slice(0, 100) : [])];
  includeGenerated = typeof options.includeGenerated === 'boolean' ? options.includeGenerated : reader?.prepare("SELECT value FROM meta WHERE key='includeGenerated'").get()?.value === 'true';
  if (readOnly && reader) state = { ...state, state: 'ready' };
  if (state.state !== 'ready') return { state: state.state, indexedAt: state.updatedAt || null, results: [] };
  const report = exclusionReport();
  // Native search has q only: explain an exact known filename, never infer a path from prose.
  const exactQueryPath = method === 'search' && typeof options.q === 'string' ? reader.prepare('SELECT path FROM excluded WHERE path=? UNION SELECT path FROM files WHERE path=? LIMIT 1').get(options.q, options.q)?.path : null;
  const requestedPath = typeof options.path === 'string' ? options.path : exactQueryPath;
  const recordedExclusion = requestedPath ? reader.prepare('SELECT reason FROM excluded WHERE path=?').get(requestedPath)?.reason : null;
  const liveExclusion = requestedPath ? exclusionReason(requestedPath) : null;
  const requestedExclusion = recordedExclusion || (liveExclusion === 'unsupported' ? null : liveExclusion);
  const evidence = { state: 'ready', indexedAt: reader.prepare("SELECT value FROM meta WHERE key='updatedAt'").get()?.value || null, includeGenerated, excludedCount: report.excludedCount, ...(requestedExclusion ? { excludedPath: { path: requestedPath, reason: requestedExclusion } } : {}) };
  const finish = (rows, total = rows.length) => ({ ...evidence, total, returned: rows.length, truncated: total > rows.length, results: rows.map((row) => ({ ...row, stale: freshness(row.path) })) });
  if (method === 'search') {
    const raw = typeof options.q === 'string' ? options.q : '';
    const path = typeof options.path === 'string' ? options.path : '';
    if (path && !allowed(path)) return finish([]);
    if (!raw && !path) return finish([]);
    if (!raw && path) {
      const rows = pathExcerpts(path);
      return { ...evidence, files: rows.length ? 1 : 0, hits: rows.length, omitted: 0, total: rows.length, returned: rows.length, truncated: false, results: rows };
    }
    const found = exactHits(raw, { regex: options.regex === true, wholeWord: options.wholeWord === true, scope: path }, limit);
    if (!found || found.invalid) return { ...evidence, files: 0, hits: 0, omitted: 0, total: 0, returned: 0, truncated: false, results: [], hint: 'Invalid regex; check pattern syntax.' };
    if (!found.results.length) return { ...evidence, files: 0, hits: 0, omitted: 0, total: 0, returned: 0, truncated: false, results: [], hint: `No exact matches for "${String(raw).slice(0, 80)}"; try a shorter literal or regex:true.` };
    return { ...evidence, files: found.files, hits: found.hits, omitted: found.omitted, total: found.hits, returned: found.results.length, truncated: found.omitted > 0, results: found.results };
  }
  if (method === 'symbols') {
    const symbol = typeof options.symbol === 'string' ? options.symbol.slice(0, 200) : '';
    const defs = symbol ? reader.prepare("SELECT path,name,kind,line FROM symbols WHERE name=? AND kind='definition' ORDER BY path,line").all(symbol).filter((row) => allowed(row.path)).map((row) => ({ ...row, stale: freshness(row.path) })) : [];
    const seenDef = new Set(defs.map((d) => `${d.path}:${d.line}`));
    let refs = [], refFiles = 0, refHits = 0;
    if (symbol) {
      const found = exactHits(symbol, {}, limit);
      if (found && !found.invalid) {
        refFiles = found.files;
        refHits = found.hits;
        refs = found.results.filter((hit) => !seenDef.has(`${hit.path}:${hit.startLine}`)).map((hit) => ({ path: hit.path, name: symbol, kind: 'reference', line: hit.startLine, stale: false }));
      }
    }
    const rows = [...defs, ...refs].slice(0, limit);
    const total = defs.length + refHits;
    const files = new Set(rows.map((r) => r.path)).size;
    return { ...evidence, files, hits: total, omitted: Math.max(0, total - rows.length), total, returned: rows.length, truncated: total > rows.length, results: rows };
  }
  const path = typeof options.path === 'string' ? options.path.replace(/\/$/, '') : '';
  if (path && (path.length > 1000 || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || sensitiveCodePath(path))) return finish([]);
  const prefix = path.replace(/[\\%_]/g, (character) => `\\${character}`) + '/%';
  const files = (path ? reader.prepare("SELECT path,imports FROM files WHERE path=? OR path LIKE ? ESCAPE '\\' ORDER BY path").all(path, prefix) : reader.prepare('SELECT path,imports FROM files ORDER BY path').all()).filter((file) => allowed(file.path));
  const projectDefinitions = new Set(reader.prepare("SELECT DISTINCT name,path FROM symbols WHERE kind='definition'").all().filter((row) => allowed(row.path)).map((row) => row.name));
  return finish(files.slice(0, limit).map((file) => {
    const imports = JSON.parse(file.imports);
    const definitions = reader.prepare("SELECT name,line,kind FROM symbols WHERE path=? AND kind='definition' ORDER BY line").all(file.path);
    const references = reader.prepare("SELECT name,line,kind FROM symbols WHERE path=? AND kind='reference' ORDER BY line").all(file.path).filter((row) => !COMMON_REFERENCES.has(row.name) || projectDefinitions.has(row.name));
    return {
      path: file.path, totals: { imports: imports.length, definitions: definitions.length, references: references.length },
      returned: { imports: Math.min(20, imports.length), definitions: Math.min(20, definitions.length), references: Math.min(20, references.length) },
      imports: imports.slice(0, 20).map((item) => {
        if (!item.target) return item;
        const target = item.target.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file.path), item.target)) : item.target.replaceAll('.', '/').replaceAll('::', '/');
        const candidates = [target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.cs', '/index.ts', '/index.js', '/__init__.py'].map((suffix) => target + suffix)];
        const resolvedPath = candidates.find((candidate) => allowed(candidate) && reader.prepare('SELECT 1 FROM files WHERE path=?').get(candidate)) || null;
        return { ...item, resolvedPath };
      }),
      definitions: definitions.slice(0, 20), references: references.slice(0, 20),
      recentChanges: reader.prepare('SELECT commitId,timestamp FROM changes WHERE path=? ORDER BY timestamp DESC LIMIT 10').all(file.path),
      coChanges: reader.prepare('SELECT b.path,count(*) AS count FROM changes a JOIN changes b ON a.commitId=b.commitId WHERE a.path=? AND b.path<>a.path GROUP BY b.path ORDER BY count DESC,b.path LIMIT 10').all(file.path).filter((row) => allowed(row.path)),
    };
  }), files.length);
}
// Bound UTF-8 IPC payloads, not just row counts (source may contain multibyte text).
function boundedResult(result) {
  const maxBytes = 48 * 1024;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) return result;
  const compact = { ...result, results: [], truncated: true };
  for (const sourceRow of result.results || []) {
    const row = { ...sourceRow };
    while (Buffer.byteLength(JSON.stringify({ state: result.state, results: [row], truncated: true }), 'utf8') > maxBytes) {
      const arrays = Object.entries(row).filter(([, value]) => Array.isArray(value) && value.length).sort((a, b) => Buffer.byteLength(JSON.stringify(b[1])) - Buffer.byteLength(JSON.stringify(a[1])));
      if (!arrays.length) break;
      const [key, values] = arrays[0];
      row[key] = values.slice(0, Math.floor(values.length / 2));
    }
    compact.results.push(row);
    if (Buffer.byteLength(JSON.stringify(compact), 'utf8') > maxBytes) {
      compact.results.pop();
      break;
    }
  }
  compact.returned = compact.results.length;
  for (const row of compact.results) if (row.returned) row.returned = { imports: row.imports.length, definitions: row.definitions.length, references: row.references.length };
  return compact;
}

function init(options) {
  root = realpathSync(options.root);
  readOnly = options.readOnly === true;
  if (!readOnly) {
    try {
      if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') throw new Error('Not a Git working tree');
    } catch {
      state = { state: 'unavailable', reason: 'not-git', files: 0, chunks: 0, symbols: 0, updatedAt: null };
      return state;
    }
  }
  if (readOnly) {
    reader = new DatabaseSync(join(options.directory, 'index.sqlite'), { readOnly: true });
    reader.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000');
    if (reader.prepare("SELECT value FROM meta WHERE key='root'").get()?.value !== root) throw new Error('Project identity mismatch');
    if (reader.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value !== '3') {
      state = { state: 'not-ready', reason: 'rebuild-required', files: 0, chunks: 0, updatedAt: null };
      return state;
    }
    state = { state: 'ready', symbols: reader.prepare('SELECT count(*) AS n FROM symbols').get().n, files: reader.prepare('SELECT count(*) AS n FROM files').get().n, chunks: 0, updatedAt: reader.prepare("SELECT value FROM meta WHERE key='updatedAt'").get()?.value || null };
    return state;
  }
  db = new DatabaseSync(join(options.directory, 'index.sqlite'));
  const storedRoot = db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get() ? db.prepare("SELECT value FROM meta WHERE key='root'").get()?.value : null;
  if (storedRoot && storedRoot !== root) throw new Error('Project identity mismatch');
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; PRAGMA max_page_count=65536; PRAGMA journal_size_limit=4194304;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,mtime REAL,size INTEGER,hash TEXT,imports TEXT);
    CREATE TABLE IF NOT EXISTS excluded(path TEXT PRIMARY KEY,reason TEXT);
    CREATE TABLE IF NOT EXISTS symbols(path TEXT,name TEXT,kind TEXT,line INTEGER);
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
    CREATE TABLE IF NOT EXISTS changes(commitId TEXT,path TEXT,timestamp INTEGER,PRIMARY KEY(commitId,path));
    CREATE INDEX IF NOT EXISTS changes_path ON changes(path);`);
  // Chunk text is no longer indexed; drop it, then reclaim pages that may contain old source values.
  if (db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value !== '3') {
    db.exec('DROP TABLE IF EXISTS chunks; DELETE FROM files; DELETE FROM symbols; DELETE FROM changes; DELETE FROM excluded; DELETE FROM meta WHERE key=\'updatedAt\'');
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schemaVersion', '3');
    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  }
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('root', root);
  exclusions = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='exclusions'").get()?.value || '[]');
  includeGenerated = db.prepare("SELECT value FROM meta WHERE key='includeGenerated'").get()?.value === 'true';
  reader = new DatabaseSync(join(options.directory, 'index.sqlite'), { readOnly: true });
  reader.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000');
  const updatedAt = reader.prepare("SELECT value FROM meta WHERE key='updatedAt'").get()?.value || null;
  state = { state: updatedAt ? 'ready' : 'not-ready', files: reader.prepare('SELECT count(*) AS n FROM files').get().n, chunks: 0, symbols: reader.prepare('SELECT count(*) AS n FROM symbols').get().n, updatedAt, indexedAt: updatedAt, includeGenerated, ...exclusionReport() };
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      const path = String(filename || '').replaceAll('\\', '/');
      if (path && sensitiveCodePath(path) && !path.startsWith('.git/')) return;
      clearTimeout(timer); timer = setTimeout(() => { if (!closed && scanEnabled) refresh(); }, 750); timer.unref();
    });
    watcher.on('error', () => { state = { ...state, watching: false }; update(); });
  } catch { state.watching = false; }
  // First refresh must come from settings-aware caller; never scan with unknown exclusions.
  return state;
}
process.on('message', ({ id, method, options = {} }) => {
  try {
    let result;
    if (method === 'init') result = init(options);
    else if (method === 'status') result = state;
    else if (method === 'refresh') { if (readOnly) throw new Error('Read-only index'); clearTimeout(timer); result = refresh(options); }
    else if (method === 'close') { closed = true; clearTimeout(timer); watcher?.close(); reader?.close(); db?.close(); result = { state: 'closed' }; }
    else if (['search', 'symbols', 'map'].includes(method)) { const saved = exclusions, savedGenerated = includeGenerated; try { result = boundedResult(query(method, options)); } finally { exclusions = saved; includeGenerated = savedGenerated; } }
    else throw new Error('Unknown code index operation');
    if (process.connected) process.send({ id, result });
  } catch { if (process.connected) process.send({ id, error: 'Code index operation failed' }); }
});
process.on('disconnect', () => { closed = true; clearTimeout(timer); watcher?.close(); reader?.close(); db?.close(); process.exit(0); });
