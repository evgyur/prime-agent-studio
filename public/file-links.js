import { t as tr, bindAttribute } from './i18n.js';
// Path-looking references in messages are candidates, whatever their extension.
// Plain prose, code blocks and external URLs stay unchanged. The server checks
// each candidate (GET /api/project-files/check) and only real, readable targets
// become links; the resolve API stays the source of truth when a link is opened.
// Line and range suffixes: `app.js:12`, `app.js:12:3`, `app.js:62-63`,
// `app.js#L4-L9`. Must equal lib/project-files.mjs (unit-tested).
export const LINE_SUFFIX = /(?:#L?\d+(?:[-:]L?\d+)?|:\d+(?:[-:]\d+)?)$/;
export function isFileReference(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) return false;
  const path = value.trim();
  if (!path || path.startsWith('#') || /^\/\//.test(path)) return false;
  // Strip the line suffix first: in `app.js:12` the colon is a location, not
  // a URL scheme like `https:` or `mailto:`.
  const stripped = path.replace(LINE_SUFFIX, '');
  if (!stripped) return false;
  if (/^[a-z][\w+.-]*:/i.test(stripped) && !/^(?:file:|[a-z]:[\\/])/i.test(stripped)) return false;
  if (/^file:/i.test(stripped) || /^[a-z]:[\\/]/i.test(stripped)) return true;
  if (/[\\/]/.test(stripped)) return true;
  // An extension needs a letter: versions such as v4.4.3 are not file names.
  return /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}$/.test(stripped);
}

export function fileLinkRenderer(marked, references, images) {
  const renderer = new marked.Renderer();
  const original = renderer.link;
  if (images)
    renderer.image = function (token) {
      const id = images.push({ href: token.href, text: token.text }) - 1;
      return `<span data-studio-image="${id}"></span>`;
    };
  renderer.link = function (token) {
    if (!isFileReference(token.href)) return original.call(this, token);
    const id = references.push(token.href) - 1;
    return `<a href="#studio-file-${id}" data-studio-file="${id}">${this.parser.parseInline(token.tokens)}</a>`;
  };
  return renderer;
}

// Statuses returned by GET /api/project-files/check that open something.
const LINKABLE = new Set(['file', 'directory', 'ambiguous']);

// Batches the checks of rendered references (one request per folder and short
// delay) and caches the answers, so streaming re-renders reuse them at once and
// links do not flicker. Missing files are retried sooner than found ones.
export function createReferenceChecker(
  fetchStatuses,
  { foundTtl = 60000, missingTtl = 10000, delay = 30 } = {},
) {
  const cache = new Map(),
    pending = new Map(),
    queue = new Map();
  let timer = null;
  function flush() {
    timer = null;
    const groups = [...queue.values()];
    queue.clear();
    for (const { cwd, basePath, waiting } of groups)
      for (const chunk of chunks([...waiting.keys()]))
        fetchStatuses(cwd, basePath, chunk).then(
          (results) => {
            const statuses = new Map((results || []).map((item) => [item.reference, item.status]));
            for (const reference of chunk) {
              const status = statuses.get(reference) || 'unknown';
              if (status !== 'unknown') {
                // Bounded memory over a long session: drop the oldest answers.
                if (cache.size >= 5000) for (const key of [...cache.keys()].slice(0, 1000)) cache.delete(key);
                cache.set(keyOf(cwd, basePath, reference), { status, at: Date.now() });
              }
              waiting.get(reference)(status);
            }
          },
          () => {
            for (const reference of chunk) waiting.get(reference)('unknown');
          },
        );
  }
  return {
    // A known status is returned at once; otherwise a promise of the status.
    check(cwd, basePath, reference) {
      if (!cwd) return 'unknown';
      const key = keyOf(cwd, basePath, reference);
      const known = cache.get(key);
      if (known && Date.now() - known.at < (LINKABLE.has(known.status) ? foundTtl : missingTtl))
        return known.status;
      if (pending.has(key)) return pending.get(key);
      const group = `${cwd}\u0000${basePath}`;
      if (!queue.has(group)) queue.set(group, { cwd, basePath, waiting: new Map() });
      const promise = new Promise((done) => queue.get(group).waiting.set(reference, done));
      pending.set(key, promise);
      void promise.then(() => pending.delete(key));
      timer ??= setTimeout(flush, delay);
      return promise;
    },
  };
}
const keyOf = (cwd, basePath, reference) => `${cwd}\u0000${basePath}\u0000${reference}`;
// Requests stay well under URL length limits: at most 50 references or about
// 6,000 encoded characters each.
function chunks(references) {
  const result = [];
  let current = [],
    size = 0;
  for (const reference of references) {
    const length = encodeURIComponent(reference).length + 11;
    if (current.length && (current.length >= 50 || size + length > 6000)) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(reference);
    size += length;
  }
  if (current.length) result.push(current);
  return result;
}

// Shared message file menu, one document level popover reused by every bound
// link. Long press on touch screens fires contextmenu in mobile browsers, so
// no separate gesture is needed. Keyboard access uses the ContextMenu key and
// Shift+F10, like the inspector file rows.
let linkMenu = null;
let linkMenuInstalled = false;
let linkMenuAnchor = null;
const linkMenuEntry = new WeakMap();

function ensureLinkMenu() {
  if (linkMenu) return linkMenu;
  linkMenu = document.createElement('div');
  linkMenu.className = 'popover-menu inspector-file-menu file-link-menu';
  linkMenu.setAttribute('role', 'menu');
  linkMenu.hidden = true;
  document.body.append(linkMenu);
  if (!linkMenuInstalled) {
    linkMenuInstalled = true;
    document.addEventListener('click', (event) => {
      if (linkMenu.hidden || event.target.closest('.inspector-file-menu')) return;
      closeLinkMenu();
    });
    document.addEventListener('scroll', () => closeLinkMenu(), true);
    window.addEventListener('resize', () => closeLinkMenu());
    document.addEventListener(
      'keydown',
      (event) => {
        if (linkMenu.hidden) return;
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          const anchor = linkMenuAnchor;
          closeLinkMenu();
          anchor?.focus({ preventScroll: true });
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const items = [...linkMenu.querySelectorAll('button:not(:disabled)')];
          const index = items.indexOf(document.activeElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus({ preventScroll: true });
        }
      },
      true,
    );
  }
  return linkMenu;
}

function closeLinkMenu() {
  if (!linkMenu || linkMenu.hidden) return;
  linkMenu.hidden = true;
  linkMenuAnchor = null;
}

export function placeViewportMenu(menu, x, y) {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const width = viewport?.width || innerWidth;
  const height = viewport?.height || innerHeight;
  menu.style.maxHeight = `${Math.max(80, height - 24)}px`;
  menu.style.left = `${Math.max(left + 12, Math.min(left + width - menu.offsetWidth - 12, x))}px`;
  menu.style.top = `${Math.max(top + 12, Math.min(top + height - menu.offsetHeight - 12, y))}px`;
}

function placeLinkMenu(menu, x, y) {
  menu.hidden = false;
  placeViewportMenu(menu, x, y);
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function openLinkMenu(anchor, x, y) {
  const entry = linkMenuEntry.get(anchor);
  if (!entry) return;
  const { reference, menu } = entry;
  const context = menu.context();
  const items = ensureLinkMenu();
  (anchor.closest('dialog[open]') || document.body).append(items);
  items.replaceChildren();
  items.setAttribute('aria-label', reference);
  const folderLabel = context.remote ? tr('ui.ouvrir_le_dossier_sur_le_pc') : tr('ui.ouvrir_le_dossier');
  const actions = [
    [
      () => tr('ui.ouvrir'),
      () => {
        const anchorNode = linkMenuAnchor;
        closeLinkMenu();
        anchorNode?.focus({ preventScroll: true });
        void entry.open(reference);
      },
      false,
    ],
    [
      () => folderLabel,
      () => {
        const anchorNode = linkMenuAnchor;
        closeLinkMenu();
        anchorNode?.focus({ preventScroll: true });
        void (async () => {
          try {
            await menu.reveal(reference, context);
            menu.toast(() => tr('ui.ouverture_demandee_sur_le_pc'));
          } catch (error) {
            menu.toast(error?.message || String(error), true);
          }
        })();
      },
      context.readOnly || !context.nativeFileOpen || !context.online,
    ],
    [
      () => tr('ui.copier_le_chemin'),
      () => {
        const anchorNode = linkMenuAnchor;
        closeLinkMenu();
        anchorNode?.focus({ preventScroll: true });
        void (async () => {
          const current = menu.context();
          try {
            const resolved = await menu.resolve(reference, current);
            const separator = current.cwd.includes('\\') ? '\\' : '/';
            await menu.copy(
              current.cwd.replace(/[\\/]$/, '') + separator + resolved.path.replaceAll('/', separator),
            );
          } catch {
            await menu.copy(reference);
          }
        })();
      },
      false,
    ],
  ];
  for (const [label, run, disabled] of actions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.disabled = Boolean(disabled);
    const update = () => {
      item.textContent = typeof label === 'function' ? label() : label;
    };
    update();
    item.onclick = run;
    items.append(item);
  }
  linkMenuAnchor = anchor;
  placeLinkMenu(items, x, y);
}

export function bindFileLinks(root, references, open, menu = null) {
  function bind(anchor, reference) {
    anchor.classList.add('document-link');
    anchor.href = '#document';
    anchor.removeAttribute('target');
    bindAttribute(anchor, 'title', () => tr('ui.apercu_du_fichier', { value1: reference }));
    anchor.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void open(reference);
    };
    if (menu) {
      linkMenuEntry.set(anchor, { reference, open, menu });
      anchor.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openLinkMenu(anchor, event.clientX, event.clientY);
      });
      anchor.addEventListener('keydown', (event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = anchor.getBoundingClientRect();
          openLinkMenu(anchor, rect.left + 16, rect.bottom + 4);
        }
      });
    }
  }
  // With a checker, a reference becomes a link only once the server confirms
  // it opens something. An unknown answer (older server, network error) keeps
  // the previous behavior: clickable, and the viewer explains any problem.
  // Outside paths stay useful only where the native folder reveal is allowed.
  function verify(reference, apply) {
    if (!menu?.check) return apply(true, 'unknown');
    const linkable = (status) => {
      if (LINKABLE.has(status) || status === 'unknown') return true;
      const context = menu.context();
      return status === 'outside' && !context.readOnly && context.nativeFileOpen && context.online;
    };
    const status = menu.check(reference, menu.context());
    if (typeof status === 'string') apply(linkable(status), status);
    else void status.then((value) => apply(linkable(value), value));
  }
  root.querySelectorAll('a').forEach((anchor) => {
    const id = anchor.getAttribute('data-studio-file');
    const reference = id !== null && /^\d+$/.test(id) ? references[Number(id)] : anchor.getAttribute('href');
    anchor.removeAttribute('data-studio-file');
    if (!isFileReference(reference)) return;
    // Not clickable until checked; a broken Markdown link reads as unavailable.
    anchor.removeAttribute('href');
    anchor.classList.add('document-link-pending');
    verify(reference, (linkable, status) => {
      anchor.classList.remove('document-link-pending');
      if (linkable) bind(anchor, reference);
      else {
        anchor.classList.add('document-link-missing');
        const key = ['blocked', 'outside'].includes(status)
          ? 'files.link_inaccessible'
          : 'files.link_unavailable';
        bindAttribute(anchor, 'title', () => tr(key, { value1: reference }));
      }
    });
  });
  root.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre, a') || !isFileReference(code.textContent)) return;
    const reference = code.textContent.trim();
    verify(reference, (linkable) => {
      if (!linkable || code.closest('a')) return;
      const anchor = document.createElement('a');
      bind(anchor, reference);
      code.replaceWith(anchor);
      anchor.append(code);
    });
  });
}
