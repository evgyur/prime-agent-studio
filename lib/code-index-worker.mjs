import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch, lstatSync, realpathSync, openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { join, relative, isAbsolute, sep, extname, matchesGlob, posix } from 'node:path';
import { setPriority, constants as osConstants } from 'node:os';

try { setPriority(0, osConstants.priority.PRIORITY_LOW); } catch { /* Restricted hosts keep default priority. */ }
const MAX_FILES = 10_000, MAX_BYTES = 64 * 1024 * 1024, MAX_FILE = 1024 * 1024;
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.cs', '.rs', '.go', '.json', '.md', '.html', '.css', '.sql', '.toml', '.yaml', '.yml', '.sh', '.ps1', '.vue', '.svelte']);
const MANIFESTS = new Set(['Makefile', 'GNUmakefile', 'Dockerfile', 'Justfile', 'justfile', 'go.mod', 'go.sum']);
const SECRET = /(^|\/)(?:\.env[^/]*|\.git|node_modules|vendor|dist|build|coverage|\.next|\.ssh|\.aws|credentials?[^/]*|secrets?[^/]*|passwords?[^/]*|(?:keys?|tokens?)(?:\.[^/]*)?|id_rsa[^/]*|id_ed25519[^/]*)(\/|$)|(?:^|[/._-])(?:private[-_]?key|api[-_]?key)(?:[._/-]|$)|\.(?:pem|key|p12|pfx|keystore)$/i;
const inside = (root, path) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
let db, reader, root, watcher, timer, exclusions = [], closed = false, readOnly = false, scanEnabled = false;
let state = { state: 'not-ready', files: 0, chunks: 0, updatedAt: null };
const update = () => { if (process.connected) process.send({ event: 'update', status: state }); };
const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const limitOf = (limit) => Math.min(50, Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 10));
function allowed(path) {
  return typeof path === 'string' && path.length < 1000 && !path.includes('\\') && !path.split('/').includes('..') && !isAbsolute(path) && !SECRET.test(path) && (EXTENSIONS.has(extname(path).toLowerCase()) || MANIFESTS.has(posix.basename(path))) && !exclusions.some((pattern) => matchesGlob(path, pattern) || path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`));
}
function source(path) {
  if (!allowed(path)) return null;
  const full = join(root, path);
  // Refuse every symlink component, including links that currently resolve inside the root.
  let cursor = root;
  for (const part of path.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) return null; }
  if (!inside(root, realpathSync(full))) return null;
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE || stat.nlink > 1 || !inside(root, realpathSync(full))) return null;
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_FILE || bytes.includes(0)) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Never persist obvious embedded credentials, even in an otherwise ordinary source filename.
    if (/-----BEGIN [^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret|access[_-]?token|private[_-]?key|authorization)["']?\s*[:=]\s*["']?[^\s"',;}{]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(text)) return null;
    return { text, size: stat.size, mtime: stat.mtimeMs, hash: hash(bytes) };
  } finally { closeSync(fd); }
}
function extract(text) {
  const lines = text.split('\n'), definitions = [], references = [], imports = [];
  // ponytail: lexical multi-language symbols, not a compiler; references are candidates, not resolved calls.
  const definition = /\b(?:class|interface|struct|enum|trait|type|def|fn|func|function)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|sealed)\s+)+(?:[\w<>?\[\],]+\s+)([A-Za-z_$][\w$]*)\s*\(/;
  for (let i = 0; i < lines.length && i < 30_000; i++) {
    const line = lines[i];
    const match = line.match(definition);
    const name = match && (match[1] || match[2] || match[3]);
    if (name) definitions.push({ name, kind: 'definition', line: i + 1 });
    if (/^\s*(?:import\b|from\s+\S+\s+import\b|using\b|use\b|(?:export|const|let|var).*\b(?:from|require)\b)/.test(line)) imports.push({ line: i + 1, text: line.trim().slice(0, 500), target: (line.match(/(?:from\s*|require\s*\(\s*|import\s*)["']([^"']+)["']/) || line.match(/(?:from|import|using|use)\s+([\w.:/]+)/))?.[1] || null });
    if (references.length < 10_000) for (const token of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (token[1] !== name && !['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof'].includes(token[1])) references.push({ name: token[1], kind: 'reference', line: i + 1 });
    }
  }
  const starts = [...new Set([1, ...definitions.map((item) => item.line)])].sort((a, b) => a - b), chunks = [];
  for (let i = 0; i < starts.length && chunks.length < 1000; i++) {
    const end = (starts[i + 1] || lines.length + 1) - 1;
    for (let start = starts[i]; start <= end && chunks.length < 1000; start += 80) {
      const endLine = Math.min(end, start + 79);
      chunks.push({ startLine: start, endLine, text: lines.slice(start - 1, endLine).join('\n').slice(0, 16_000) });
    }
  }
  return { definitions: definitions.slice(0, 2000), references: references.slice(0, 10_000), imports: imports.slice(0, 500), chunks };
}
function refresh(options = {}) {
  if (!db) return state;
  scanEnabled = true;
  if (Array.isArray(options.exclusions)) exclusions = options.exclusions.filter((v) => typeof v === 'string' && v.length <= 300).slice(0, 100);
  state = { ...state, state: 'indexing', progress: undefined, error: undefined }; update();
  try {
    const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(allowed))].sort().slice(0, MAX_FILES);
    state = { ...state, progress: { completed: 0, total: paths.length } }; update();
    const seen = new Set(); let bytes = 0, changed = 0, completed = 0;
    const putFile = db.prepare('INSERT OR REPLACE INTO files(path,mtime,size,hash,imports) VALUES(?,?,?,?,?)');
    const putChunk = db.prepare('INSERT INTO chunks(path,startLine,endLine,text) VALUES(?,?,?,?)');
    const putSymbol = db.prepare('INSERT INTO symbols(path,name,kind,line) VALUES(?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (options.rebuild) db.exec('DELETE FROM files; DELETE FROM chunks; DELETE FROM symbols');
      for (const path of paths) {
        completed++;
        if (completed % 100 === 0) {
          state = { ...state, progress: { completed, total: paths.length } }; update();
        }
        let item; try { item = source(path); } catch { continue; }
        if (!item) continue;
        bytes += item.size; if (bytes > MAX_BYTES) break;
        seen.add(path);
        const old = db.prepare('SELECT mtime,size,hash FROM files WHERE path=?').get(path);
        if (old && old.hash === item.hash) {
          if (old.mtime !== item.mtime || old.size !== item.size) db.prepare('UPDATE files SET mtime=?,size=? WHERE path=?').run(item.mtime, item.size, path);
          continue;
        }
        const parsed = extract(item.text);
        db.prepare('DELETE FROM chunks WHERE path=?').run(path); db.prepare('DELETE FROM symbols WHERE path=?').run(path);
        putFile.run(path, item.mtime, item.size, item.hash, JSON.stringify(parsed.imports));
        for (const chunk of parsed.chunks) putChunk.run(path, chunk.startLine, chunk.endLine, chunk.text);
        for (const symbol of [...parsed.definitions, ...parsed.references]) putSymbol.run(path, symbol.name, symbol.kind, symbol.line);
        changed++;
      }
      for (const { path } of db.prepare('SELECT path FROM files').all()) if (!seen.has(path)) {
        db.prepare('DELETE FROM files WHERE path=?').run(path); db.prepare('DELETE FROM chunks WHERE path=?').run(path); db.prepare('DELETE FROM symbols WHERE path=?').run(path); changed++;
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
      const updatedAt = new Date().toISOString();
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('updatedAt', updatedAt);
      db.exec('COMMIT');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      state = { state: 'ready', progress: { completed, total: paths.length }, symbols: db.prepare('SELECT count(*) AS n FROM symbols').get().n, files: seen.size, chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n, updatedAt, changed, bytes, capped: paths.length >= MAX_FILES || bytes > MAX_BYTES };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { state = { ...state, state: 'error', error: 'Local code index refresh failed', detail: error.code || 'INDEX_ERROR' }; }
  update(); return state;
}
function query(method, options) {
  const limit = limitOf(options.limit);
  const persistedExclusions = reader ? JSON.parse(reader.prepare("SELECT value FROM meta WHERE key='exclusions'").get()?.value || '[]') : [];
  exclusions = [...persistedExclusions, ...(Array.isArray(options.exclusions) ? options.exclusions.filter((value) => typeof value === 'string' && value.length <= 300).slice(0, 100) : [])];
  if (readOnly && reader) state = { ...state, state: 'ready' };
  if (state.state !== 'ready') return { state: state.state, results: [] };
  if (method === 'search') {
    const words = typeof options.q === 'string' ? options.q.slice(0, 1000).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) : null;
    const path = typeof options.path === 'string' ? options.path : '';
    if (path && !allowed(path)) return { state: 'ready', results: [] };
    if (!words?.length) return { state: 'ready', results: path ? reader.prepare('SELECT path,startLine,endLine,substr(text,1,4000) AS text,0 AS score FROM chunks WHERE path=? ORDER BY startLine LIMIT ?').all(path, limit) : [] };
    const q = words.map((word) => `"${word}"`).join(' OR ');
    const rows = path
      ? reader.prepare('SELECT path,startLine,endLine,substr(text,1,4000) AS text,bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? AND path=? ORDER BY score LIMIT ?').all(q, path, limit)
      : reader.prepare('SELECT path,startLine,endLine,substr(text,1,4000) AS text,bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?').all(q, limit);
    return { state: 'ready', results: rows.filter((row) => allowed(row.path)) };
  }
  if (method === 'symbols') {
    const symbol = typeof options.symbol === 'string' ? options.symbol.slice(0, 200) : '';
    return { state: 'ready', results: symbol ? reader.prepare('SELECT path,name,kind,line FROM symbols WHERE name=? ORDER BY kind,path,line LIMIT ?').all(symbol, limit).filter((row) => allowed(row.path)) : [] };
  }
  const path = typeof options.path === 'string' ? options.path.replace(/\/$/, '') : '';
  if (path && (path.length > 1000 || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || SECRET.test(path))) return { state: 'ready', results: [] };
  const prefix = path.replace(/[\\%_]/g, (character) => `\\${character}`) + '/%';
  const files = path ? reader.prepare("SELECT path,imports FROM files WHERE path=? OR path LIKE ? ESCAPE '\\' ORDER BY path LIMIT ?").all(path, prefix, limit) : reader.prepare('SELECT path,imports FROM files ORDER BY path LIMIT ?').all(limit);
  return { state: 'ready', results: files.filter((file) => allowed(file.path)).map((file) => ({
    path: file.path, imports: JSON.parse(file.imports).slice(0, 20).map((item) => {
      if (!item.target) return item;
      const target = item.target.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file.path), item.target)) : item.target.replaceAll('.', '/').replaceAll('::', '/');
      const candidates = [target, ...['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.cs', '/index.ts', '/index.js', '/__init__.py'].map((suffix) => target + suffix)];
      const resolvedPath = candidates.find((candidate) => allowed(candidate) && reader.prepare('SELECT 1 FROM files WHERE path=?').get(candidate)) || null;
      return { ...item, resolvedPath };
    }),
    definitions: reader.prepare("SELECT name,line,kind FROM symbols WHERE path=? AND kind='definition' LIMIT 20").all(file.path),
    references: reader.prepare("SELECT name,line,kind FROM symbols WHERE path=? AND kind='reference' LIMIT 20").all(file.path),
    recentChanges: reader.prepare('SELECT commitId,timestamp FROM changes WHERE path=? ORDER BY timestamp DESC LIMIT 10').all(file.path),
    coChanges: reader.prepare('SELECT b.path,count(*) AS count FROM changes a JOIN changes b ON a.commitId=b.commitId WHERE a.path=? AND b.path<>a.path GROUP BY b.path ORDER BY count DESC,b.path LIMIT 10').all(file.path).filter((row) => allowed(row.path)),
  })) };
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
    state = { state: 'ready', symbols: reader.prepare('SELECT count(*) AS n FROM symbols').get().n, files: reader.prepare('SELECT count(*) AS n FROM files').get().n, chunks: reader.prepare('SELECT count(*) AS n FROM chunks').get().n, updatedAt: reader.prepare("SELECT value FROM meta WHERE key='updatedAt'").get()?.value || null };
    return state;
  }
  db = new DatabaseSync(join(options.directory, 'index.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; PRAGMA max_page_count=65536; PRAGMA journal_size_limit=4194304;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,mtime REAL,size INTEGER,hash TEXT,imports TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED,startLine UNINDEXED,endLine UNINDEXED,text);
    CREATE TABLE IF NOT EXISTS symbols(path TEXT,name TEXT,kind TEXT,line INTEGER);
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
    CREATE TABLE IF NOT EXISTS changes(commitId TEXT,path TEXT,timestamp INTEGER,PRIMARY KEY(commitId,path));
    CREATE INDEX IF NOT EXISTS changes_path ON changes(path);`);
  const storedRoot = db.prepare("SELECT value FROM meta WHERE key='root'").get()?.value;
  if (storedRoot && storedRoot !== root) throw new Error('Project identity mismatch');
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('root', root);
  exclusions = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='exclusions'").get()?.value || '[]');
  reader = new DatabaseSync(join(options.directory, 'index.sqlite'), { readOnly: true });
  reader.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000');
  const updatedAt = reader.prepare("SELECT value FROM meta WHERE key='updatedAt'").get()?.value || null;
  state = { state: updatedAt ? 'ready' : 'not-ready', files: reader.prepare('SELECT count(*) AS n FROM files').get().n, chunks: reader.prepare('SELECT count(*) AS n FROM chunks').get().n, symbols: reader.prepare('SELECT count(*) AS n FROM symbols').get().n, updatedAt };
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      const path = String(filename || '').replaceAll('\\', '/');
      if (path && SECRET.test(path) && !path.startsWith('.git/')) return;
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
    else if (['search', 'symbols', 'map'].includes(method)) { const saved = exclusions; try { result = boundedResult(query(method, options)); } finally { exclusions = saved; } }
    else throw new Error('Unknown code index operation');
    if (process.connected) process.send({ id, result });
  } catch { if (process.connected) process.send({ id, error: 'Code index operation failed' }); }
});
process.on('disconnect', () => { closed = true; clearTimeout(timer); watcher?.close(); reader?.close(); db?.close(); process.exit(0); });
