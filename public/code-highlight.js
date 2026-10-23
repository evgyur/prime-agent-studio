// Syntax highlighting shared module (highlight.js, served locally).
// Pure helpers at the top are node-safe: no DOM, no '/vendor/...' import at
// module top level, so node unit tests can import this file directly.
// Browser enhancement (dynamic import, IntersectionObserver, DOM painting)
// lives further down and only runs when called from the UI.

// Conservative limits: above them the UI keeps plain text.
export const HIGHLIGHT_MAX_BYTES = 512 * 1024;
export const HIGHLIGHT_MAX_LINES = 5000;
export const HIGHLIGHT_MAX_LINE_LENGTH = 4000;
// Per conversation code block: larger blocks stay plain text.
export const HIGHLIGHT_BLOCK_MAX_CHARS = 50000;
// Cache of highlighted blocks (language + text -> numbered lines), bounded by
// entries and by total characters: a few large files must not pin memory.
export const HIGHLIGHT_CACHE_SIZE = 200;
export const HIGHLIGHT_CACHE_MAX_CHARS = 4 * 1024 * 1024;

// Languages bundled in es/highlight.min.js (36 common languages).
export const HIGHLIGHT_BUNDLED_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'go',
  'graphql',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'less',
  'lua',
  'makefile',
  'markdown',
  'objectivec',
  'perl',
  'php',
  'php-template',
  'plaintext',
  'python',
  'python-repl',
  'r',
  'ruby',
  'rust',
  'scss',
  'shell',
  'sql',
  'swift',
  'typescript',
  'vbnet',
  'wasm',
  'xml',
  'yaml',
];

// Extra languages served locally on explicit allowlist routes only
// (/vendor/hljs-<name>.js). Never an arbitrary path.
export const HIGHLIGHT_EXTRA_LANGUAGES = {
  powershell: '/vendor/hljs-powershell.js',
  dos: '/vendor/hljs-dos.js',
  dockerfile: '/vendor/hljs-dockerfile.js',
  cmake: '/vendor/hljs-cmake.js',
  nginx: '/vendor/hljs-nginx.js',
  properties: '/vendor/hljs-properties.js',
};

export const isHighlightLanguage = (language) =>
  HIGHLIGHT_BUNDLED_LANGUAGES.includes(language) || Object.hasOwn(HIGHLIGHT_EXTRA_LANGUAGES, language);

const FENCE_ALIASES = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  sh: 'shell',
  zsh: 'shell',
  console: 'shell',
  shellsession: 'shell',
  yml: 'yaml',
  html: 'xml',
  xhtml: 'xml',
  md: 'markdown',
  mkd: 'markdown',
  mdown: 'markdown',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  batch: 'dos',
  make: 'makefile',
  mk: 'makefile',
  dockerfile: 'dockerfile',
  'c++': 'cpp',
  'c#': 'csharp',
  rs: 'rust',
  kt: 'kotlin',
  toml: 'ini',
  jsonc: 'json',
  json5: 'json',
  pwsh: 'powershell',
  vb: 'vbnet',
};

// Markdown fence info (```js) -> highlight.js language, or null for plain.
export function languageForFence(info) {
  if (info == null) return null;
  const token = String(info)
    .trim()
    .toLowerCase()
    .split(/[\s,;]+/)[0]
    .replace(/^\./, '');
  if (!token) return null;
  const language = FENCE_ALIASES[token] || token;
  return isHighlightLanguage(language) ? language : null;
}

const EXTENSION_TO_LANGUAGE = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  vue: 'xml',
  json: 'json',
  jsonc: 'json',
  xml: 'xml',
  toml: 'ini',
  vb: 'vbnet',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ini: 'ini',
  cfg: 'ini',
  gql: 'graphql',
  graphql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  cmake: 'cmake',
  properties: 'properties',
  txt: 'plaintext',
  text: 'plaintext',
  log: 'plaintext',
  h: 'c',
};

const FILENAME_TO_LANGUAGE = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
};

// File path -> highlight.js language, or null (plain text, no auto-detect).
export function languageForPath(path) {
  if (!path || typeof path !== 'string') return null;
  const base = path.split(/[\\/]/).pop().toLowerCase();
  if (!base) return null;
  if (Object.hasOwn(FILENAME_TO_LANGUAGE, base)) return FILENAME_TO_LANGUAGE[base];
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile'))
    return 'dockerfile';
  if (base === 'makefile' || base.startsWith('makefile.') || base.endsWith('.makefile')) return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_TO_LANGUAGE[base.slice(dot + 1)] || null;
}

// Null when the text may be highlighted, otherwise a short reason code.
// Single pass over the text: counts lines and tracks the longest line.
export function highlightLimit(text) {
  const value = String(text ?? '');
  if (value.length > HIGHLIGHT_MAX_BYTES) return 'too-large';
  let lines = 1;
  let longest = 0;
  let current = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) {
      if (current > longest) longest = current;
      current = 0;
      lines++;
      if (lines > HIGHLIGHT_MAX_LINES) return 'too-many-lines';
    } else {
      current++;
    }
  }
  if (current > longest) longest = current;
  if (longest > HIGHLIGHT_MAX_LINE_LENGTH) return 'line-too-long';
  return null;
}

export const canHighlightFile = (text) => highlightLimit(text) === null;

export function canHighlightBlock(language, text) {
  if (!language || !isHighlightLanguage(language)) return false;
  const value = String(text ?? '');
  if (!value || value.length > HIGHLIGHT_BLOCK_MAX_CHARS) return false;
  return highlightLimit(value) === null;
}

// A raw carriage return would be turned into \n by the HTML parser of
// innerHTML: Windows (CRLF) files would never match their source text and
// would stay plain. The &#13; reference keeps it exact.
const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');

const ENTITY = /^&(amp|lt|gt|quot|#\d+|#x[\dA-Fa-f]+);$/;
const TOKEN = /<span class="([^"]*)">|<\/span>|&[^;\s]*;?|[^<&]+|[<&]/g;

// highlight.js HTML -> one HTML string per line, with spans reopened across
// newlines. Output is built only from escaped text plus <span class="...">
// with hljs-* classes, so inserting it never injects unsanitized HTML.
export function splitHighlightLines(html) {
  const lines = [''];
  const stack = [];
  const open = () => stack.map((cls) => (cls ? `<span class="${cls}">` : '<span>')).join('');
  const close = (count) => '</span>'.repeat(count);
  const input = String(html ?? '');
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(input)) !== null) {
    const token = match[0];
    if (token.startsWith('<span')) {
      // hljs-* classes plus the scope modifiers highlight.js adds to them
      // (title.function -> "hljs-title function_", title.function.invoke ->
      // "... invoke__"): lowercase letters and underscores only.
      const kept = match[1]
        .split(/\s+/)
        .filter((cls) => /^hljs-[\w-]+$/.test(cls) || /^[a-z]+_+$/.test(cls))
        .join(' ');
      stack.push(kept);
      lines[lines.length - 1] += kept ? `<span class="${kept}">` : '<span>';
    } else if (token === '</span>') {
      if (stack.length > 0) {
        stack.pop();
        lines[lines.length - 1] += '</span>';
      }
    } else if (token === '&' || token === '<') {
      lines[lines.length - 1] += escapeHtml(token);
    } else if (token.startsWith('&')) {
      lines[lines.length - 1] += ENTITY.test(token) ? token : escapeHtml(token);
    } else if (token.includes('\n')) {
      const parts = token.split('\n');
      lines[lines.length - 1] += escapeHtml(parts[0]) + close(stack.length);
      for (let i = 1; i < parts.length; i++) lines.push(open() + escapeHtml(parts[i]));
    } else {
      lines[lines.length - 1] += escapeHtml(token);
    }
  }
  return lines;
}

// Cheap cache key: FNV-1a over language + text, plus length.
export function highlightCacheKey(language, text) {
  const value = `${language}\n${text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${language}:${value.length}:${(hash >>> 0).toString(16)}`;
}

// Small perf counters for tests and the long-conversation measurement.
// Counts only, no content.
export const highlightStats = { blocks: 0, cacheHits: 0, skipped: 0, totalMs: 0 };
export function resetHighlightStats() {
  highlightStats.blocks = 0;
  highlightStats.cacheHits = 0;
  highlightStats.skipped = 0;
  highlightStats.totalMs = 0;
}

// --- Browser enhancement (DOM + dynamic import). Never called in node. ---

const lineCache = new Map();
let cachedChars = 0;
export function cachedHighlightLines(language, text, highlight) {
  const key = highlightCacheKey(language, text);
  const cached = lineCache.get(key);
  // The key is a hash: compare the text so a collision never shows other code.
  if (cached && cached.language === language && cached.text === text) {
    highlightStats.cacheHits++;
    return cached.lines;
  }
  const started = performance.now();
  const lines = splitHighlightLines(highlight(text, { language }).value);
  highlightStats.totalMs += performance.now() - started;
  highlightStats.blocks++;
  if (cached) {
    lineCache.delete(key);
    cachedChars -= cached.size;
  }
  const size = text.length + lines.reduce((total, line) => total + line.length, 0);
  lineCache.set(key, { language, text, lines, size });
  cachedChars += size;
  // Oldest first; the entry just added always stays.
  for (const [oldKey, entry] of lineCache) {
    if (
      lineCache.size <= 1 ||
      (lineCache.size <= HIGHLIGHT_CACHE_SIZE && cachedChars <= HIGHLIGHT_CACHE_MAX_CHARS)
    )
      break;
    lineCache.delete(oldKey);
    cachedChars -= entry.size;
  }
  return lines;
}

let hljsPromise = null;
const registeredExtras = new Set();
export function loadHljs() {
  // A failed load (server restarting) is retried by the next block.
  hljsPromise ??= import('/vendor/hljs.js').then(
    (module) => module.default || module,
    (error) => {
      hljsPromise = null;
      throw error;
    },
  );
  return hljsPromise;
}

export async function ensureHljsLanguage(hljs, language) {
  if (!Object.hasOwn(HIGHLIGHT_EXTRA_LANGUAGES, language) || hljs.getLanguage(language)) return hljs;
  if (!registeredExtras.has(language)) {
    const module = await import(HIGHLIGHT_EXTRA_LANGUAGES[language]);
    hljs.registerLanguage(language, module.default || module);
    registeredExtras.add(language);
  }
  return hljs;
}

const whenIdle = (work) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(work, { timeout: 800 });
  else setTimeout(work, 0);
};

let blockObserver = null;
// One shared observer, but each target keeps its own work: the observer
// callback must never close over the work of the first observed element.
const pendingWorks = new Map();
function observeBlock(element, work) {
  if (typeof IntersectionObserver === 'function') {
    if (!blockObserver)
      blockObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          blockObserver.unobserve(entry.target);
          const pending = pendingWorks.get(entry.target);
          pendingWorks.delete(entry.target);
          if (!pending) continue;
          whenIdle(() => {
            if (entry.target.isConnected) pending();
          });
        }
      });
    // Re-rendered or paged-out blocks may never become visible: drop the
    // detached ones so a long session does not accumulate them.
    if (pendingWorks.size > 200)
      for (const target of pendingWorks.keys())
        if (!target.isConnected) {
          blockObserver.unobserve(target);
          pendingWorks.delete(target);
        }
    // Hard cap: the oldest never-visible blocks simply stay plain text.
    for (const target of pendingWorks.keys()) {
      if (pendingWorks.size < 400) break;
      blockObserver.unobserve(target);
      pendingWorks.delete(target);
    }
    pendingWorks.set(element, work);
    blockObserver.observe(element);
    return;
  }
  whenIdle(() => element.isConnected && work());
}

// Paint one block per line into a <code> element. Each line ends with its
// own newline: whitespace text between block lines would render as blank
// lines. A final newline closes the last line instead of opening an empty
// one. The code element keeps exactly the source text.
export function paintNumberedLines(code, lines) {
  code.replaceChildren();
  code.classList.add('hljs');
  const document_ = code.ownerDocument;
  const count = lines.length > 1 && lines.at(-1) === '' ? lines.length - 1 : lines.length;
  for (let index = 0; index < count; index++) {
    const line = document_.createElement('span');
    line.className = 'code-line';
    // From splitHighlightLines: escaped text plus <span class="hljs-..."> only,
    // built above, never raw input HTML.
    line.innerHTML = lines[index];
    if (index < lines.length - 1) line.append('\n');
    code.append(line);
  }
}

// Enhance every code block under root that carries data-hl-language.
// Blocks without a known language or above the size cap stay plain text.
export function enhanceCodeBlocks(root, { enabled = false } = {}) {
  if (!enabled || !root || typeof root.querySelectorAll !== 'function') return;
  const pres = root.querySelectorAll('pre[data-hl-language]');
  for (const pre of pres) {
    if (pre.dataset.hlDone) continue;
    pre.dataset.hlDone = '1';
    const code = pre.querySelector('code');
    if (!code) continue;
    const language = languageForFence(pre.dataset.hlLanguage || '');
    const text = code.textContent;
    if (!canHighlightBlock(language, text)) {
      highlightStats.skipped++;
      continue;
    }
    observeBlock(pre, async () => {
      try {
        const hljs = await ensureHljsLanguage(await loadHljs(), language);
        if (!pre.isConnected) return;
        // Skip stale nodes: repaints (streaming, paging) replace the block.
        if (code.textContent !== text) return;
        paintNumberedLines(
          code,
          cachedHighlightLines(language, text, (value, options) => hljs.highlight(value, options)),
        );
      } catch (error) {
        // Plain text stays readable when highlighting fails.
      }
    });
  }
}

// File preview: highlight `pre` content in place once visible. The paint
// targets this exact `pre` element: a newer view replaces the element (which
// disconnects this one) or changes its text, and both cases skip the paint.
export function enhanceFileBlock(pre, { language, text } = {}) {
  if (!pre || !language || !isHighlightLanguage(language)) return;
  if (!canHighlightFile(text)) {
    highlightStats.skipped++;
    return;
  }
  observeBlock(pre, async () => {
    try {
      const hljs = await ensureHljsLanguage(await loadHljs(), language);
      if (!pre.isConnected) return;
      if (pre.textContent !== text) return;
      const code = pre.ownerDocument.createElement('code');
      const lines = cachedHighlightLines(language, text, (value, options) => hljs.highlight(value, options));
      paintNumberedLines(code, lines);
      // Painted lines carry the same text (line spans joined by '\n'
      // text nodes), so .inspector-code textContent stays identical.
      if (code.textContent !== text) return;
      pre.replaceChildren(code);
    } catch (error) {
      // Plain text stays readable when highlighting fails.
    }
  });
}
