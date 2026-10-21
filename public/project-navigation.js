import { t, bindAttribute, getLanguage } from './i18n.js';

const PAGE_SIZE = 5;
const pathKey = (value) =>
  String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .toLowerCase();
const time = (value) => (typeof value === 'number' ? value : Date.parse(value)) || 0;

export function pendingQuestionCount(run) {
  if (run?.status !== 'running' || !Array.isArray(run.interactions)) return 0;
  // A replayed answer supersedes an older pending snapshot of that request.
  const current = new Map();
  for (const request of run.interactions) {
    if (request && typeof request === 'object') current.set(request.id || request, request);
  }
  return [...current.values()].filter(
    (request) => request.status === 'pending' && request.answer === undefined,
  ).length;
}

export const hasPendingQuestion = (run) => pendingQuestionCount(run) > 0;

export function conversationActivity(session, runs, unread = false) {
  const matching = runs.filter(
    (run) => (session.runId && run.id === session.runId) || (session.id && run.sessionId === session.id),
  );
  if (matching.some(hasPendingQuestion)) return 'question';
  if (session.runId || matching.some((run) => ['running', 'stopping'].includes(run.status))) return 'running';
  return unread ? 'unread' : 'idle';
}

// Folder tint palette. Exactly six choices, first is transparent (reset).
// Mirrors lib/store.mjs PROJECT_FOLDER_COLORS. Folder and pin icons share the tint.
export const PROJECT_FOLDER_COLORS = [
  'transparent',
  '#3b82f6',
  '#16a34a',
  '#d97706',
  '#dc2626',
  '#8b5cf6',
];
// Legacy pastel assignments migrate to the vivid family. Mirrors lib/store.mjs.
export const LEGACY_PROJECT_FOLDER_MAP = {
  '#7fa6c9': '#3b82f6',
  '#8fb49e': '#16a34a',
  '#d0a75e': '#d97706',
  '#c98a7d': '#dc2626',
  '#a99ac9': '#8b5cf6',
};
export const LEGACY_PROJECT_FOLDER_COLORS = Object.keys(LEGACY_PROJECT_FOLDER_MAP);
export function projectFolderColor(project) {
  const raw = typeof project?.color === 'string' ? project.color.toLowerCase() : '';
  if (PROJECT_FOLDER_COLORS.slice(1).includes(raw)) return raw;
  if (Object.hasOwn(LEGACY_PROJECT_FOLDER_MAP, raw)) return LEGACY_PROJECT_FOLDER_MAP[raw];
  return '';
}

// Device that last pushed the active leaf of a conversation, for the origin
// marker. Returns the device object when the conversation was last run on
// ANOTHER PC, otherwise null (unconfigured, local, self, or unknown).
export function selfDeviceId(sync) {
  if (!sync || typeof sync !== 'object') return null;
  const devices = Array.isArray(sync.devices) ? sync.devices : [];
  return sync.deviceId || devices.find((d) => d?.self)?.id || null;
}
export function sessionOriginDevice(sessionId, sync) {
  if (!sync?.configured || !sessionId) return null;
  const map =
    sync.sessionDevices && typeof sync.sessionDevices === 'object' ? sync.sessionDevices : null;
  if (!map) return null;
  const deviceId = map[sessionId];
  if (!deviceId) return null;
  const self = selfDeviceId(sync);
  if (self && deviceId === self) return null;
  const devices = Array.isArray(sync.devices) ? sync.devices : [];
  const found = devices.find((d) => d?.id === deviceId);
  if (found) {
    if (found.self) return null;
    return found;
  }
  if (self && deviceId !== self) return { id: deviceId, name: deviceId, color: '' };
  return null;
}

// Sync badge for a project folder. Returns 'synced', 'pending', 'syncing',
// 'error' or null (no badge: sync off, unconfigured, opted out, missing).
// The badge never replaces the folder or its color.
export function projectSyncBadge(project, sync) {
  if (!sync?.configured) return null;
  if (!project || project.sync === false) return null;
  if (project.exists === false) return null;
  if (sync.running) return 'syncing';
  const last = sync.lastSync;
  if (last && last.ok === false) return 'error';
  const map = sync.sessions || {};
  for (const s of project.sessions || []) {
    if (!s?.id) continue;
    const st = map[s.id];
    if (st === 'pending') return 'pending';
    if (st !== 'synced') return 'pending';
  }
  return 'synced';
}



// Disclosure and pagination are view preferences. They never change the selected
// conversation, its draft, or the lifetime of an agent.
export function createProjectNavigation({
  root,
  scroller,
  el,
  icon,
  activityDot,
  read,
  write,
  selectProject,
  selectSession,
  selectRun,
  openProjectMenu,
  openSessionMenu,
  addProject,
}) {
  const stored = read('project-disclosures', {});
  const expanded = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const limits = new Map();
  let signature = '',
    current;
  const setExpanded = (cwd, value) => {
    expanded[pathKey(cwd)] = value;
    write('project-disclosures', expanded);
  };
  const text = (tag, className, key, params) => el(tag, className, () => t(key, params));
  function render(context = current) {
    if (!context) return;
    current = context;
    const { projects, projectCwd, sessionId, viewRunId, archived, query, readOnly, runs, unreadIds, sync } =
      context;
    const needle = query.trim().toLocaleLowerCase(getLanguage());
    const activeRuns = runs.filter((run) => ['running', 'stopping'].includes(run.status));
    const nextSignature = JSON.stringify([
      projects,
      projectCwd,
      sessionId,
      viewRunId,
      archived,
      needle,
      readOnly,
      sync
        ? [
            sync.configured,
            sync.running,
            sync.pending,
            sync.lastSync,
            sync.sessions,
            sync.progress,
            sync.devices,
            sync.sessionDevices,
            sync.deviceId,
            sync.color,
          ]
        : null,
      activeRuns.map((run) => [
        run.id,
        run.cwd,
        run.sessionId,
        run.prompt,
        run.startedAt,
        hasPendingQuestion(run),
      ]),
      unreadIds,
      expanded,
      [...limits],
      getLanguage(),
    ]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const scroll = scroller.scrollTop;
    const focused = root.contains(document.activeElement)
      ? document.activeElement.dataset.navigationKey
      : null;
    root.replaceChildren();
    const items = [...projects].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    let group = null,
      rendered = 0;
    for (const p of items) {
      const key = pathKey(p.cwd),
        name = p.name || p.cwd.split(/[\\/]/).pop();
      const projectRuns = activeRuns.filter((run) => pathKey(run.cwd) === key);
      // Server returns stable manual order (pinned first). Preserve it verbatim;
      // new activity/messages never reorder. Ephemeral runs (no id yet) join
      // the top of unpinned until persisted, then take a stable position.
      const stored = (p.sessions || []).map((s) => ({ ...s, cwd: s.cwd || p.cwd }));
      const sessions = stored;
      const ephemeral = [];
      for (const run of projectRuns) {
        if (!stored.some((s) => s.id && s.id === run.sessionId))
          ephemeral.push({
            id: run.sessionId,
            runId: run.id,
            cwd: p.cwd,
            title: run.prompt?.slice(0, 100) || t('ui.nouvelle_session'),
            updatedAt: run.startedAt,
          });
      }
      const ordered = [
        ...stored.filter((s) => s.pinned),
        ...ephemeral,
        ...stored.filter((s) => !s.pinned),
      ];
      const matchesProject = `${name} ${p.cwd}`.toLocaleLowerCase(getLanguage()).includes(needle);
      const visible = ordered.filter(
        (s) =>
          Boolean(s.archived) === archived &&
          (!needle ||
            matchesProject ||
            String(s.title || '')
              .toLocaleLowerCase(getLanguage())
              .includes(needle)),
      );
      if ((needle && !matchesProject && !visible.length) || (archived && !visible.length)) continue;
      const pinned = Boolean(p.pinned);
      if (group !== pinned) {
        root.append(text('h2', 'project-group-label', pinned ? 'navigation.pinned' : 'ui.projets'));
        group = pinned;
      }
      rendered++;
      const isOpen = Boolean(
        needle ||
        archived ||
        (expanded[key] ?? ((pinned && visible.length > 0) || key === pathKey(projectCwd))),
      );
      const entry = el('div', 'project-entry');
      entry.dataset.cwd = p.cwd;
      entry.dataset.pinned = String(pinned);
      const header = el('div', 'project-header');
      const children = el('div', 'project-conversations');
      children.id = `project-conversations-${items.indexOf(p)}`;
      children.hidden = !isOpen;
      const toggle = el('button', 'project-toggle');
      toggle.type = 'button';
      toggle.disabled = Boolean(needle || archived);
      toggle.dataset.navigationKey = `toggle:${key}`;
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-controls', children.id);
      bindAttribute(toggle, 'aria-label', () =>
        t(isOpen ? 'navigation.collapse' : 'navigation.expand', { name }),
      );
      toggle.append(icon('chevron'));
      toggle.onclick = () => {
        setExpanded(p.cwd, !isOpen);
        render();
      };
      const row = el('button', `project-row${key === pathKey(projectCwd) ? ' active' : ''}`);
      row.type = 'button';
      row.dataset.navigationKey = `project:${key}`;
      row.setAttribute('aria-pressed', String(key === pathKey(projectCwd)));
      bindAttribute(row, 'title', () => p.cwd);
      const status = projectRuns.some(hasPendingQuestion)
        ? 'question'
        : projectRuns.length
          ? 'running'
          : sessions.some((s) => unreadIds.includes(s.id))
            ? 'unread'
            : 'idle';
      row.dataset.activity = status;
      const folderIcon = icon('folder');
      folderIcon.classList.add('project-folder-icon');
      const folderTint = projectFolderColor(p);
      if (folderTint) {
        folderIcon.querySelector('svg').style.fill = folderTint;
        folderIcon.style.color = folderTint;
      }
      row.dataset.projectColor = folderTint || 'transparent';
      const folderWrap = el('span', 'project-folder-wrap');
      folderWrap.append(folderIcon);
      const badgeState = projectSyncBadge(p, sync);
      if (badgeState) {
        const badge = document.createElement('span');
        badge.className = 'sync-badge';
        badge.dataset.state = badgeState;
        badge.setAttribute('role', 'img');
        if (badgeState === 'synced') {
          badge.append(icon('check'));
          bindAttribute(badge, 'aria-label', () => t('sync.badge_synced'));
          bindAttribute(badge, 'title', () => t('sync.badge_synced'));
        } else if (badgeState === 'pending') {
          badge.append(icon('upload'));
          bindAttribute(badge, 'aria-label', () => t('sync.badge_pending'));
          bindAttribute(badge, 'title', () => t('sync.badge_pending'));
        } else if (badgeState === 'syncing') {
          badge.append(icon('refresh'));
          bindAttribute(badge, 'aria-label', () => t('sync.badge_syncing'));
          bindAttribute(badge, 'title', () => t('sync.badge_syncing'));
        } else {
          badge.append(icon('alert'));
          bindAttribute(badge, 'aria-label', () => t('sync.badge_error'));
          bindAttribute(badge, 'title', () => t('sync.badge_error'));
        }
        folderWrap.append(badge);
      }
      row.append(folderWrap, el('span', 'project-label', () => name));
      if (pinned) {
        const projectPin = icon('pin', 'project-pin');
        if (folderTint) projectPin.style.color = folderTint;
        row.append(projectPin);
      }
      if (status !== 'idle') row.append(activityDot(status, true));
      const count = el('span', 'project-count', () => (p.exists === false ? '!' : String(visible.length)));
      if (p.exists === false) bindAttribute(count, 'title', () => t('ui.dossier_introuvable'));
      row.append(count);
      row.onclick = () => {
        // On phones, the project name is a larger disclosure target in the drawer.
        if (matchMedia('(max-width: 760px)').matches) return toggle.click();
        setExpanded(p.cwd, true);
        selectProject(p.cwd);
      };
      row.oncontextmenu = (event) => {
        event.preventDefault();
        openProjectMenu(p.cwd, row);
      };
      header.append(toggle, row);
      if (!readOnly && items.length > 1 && !needle && !archived) {
        const handle = el('button', 'project-drag-handle');
        handle.type = 'button';
        handle.dataset.navigationKey = `drag:${key}`;
        bindAttribute(handle, 'aria-label', () => t('projects.drag', { name }));
        bindAttribute(handle, 'title', () => t('projects.drag_hint'));
        handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
        handle.append(icon('grip'));
        header.append(handle);
      }
      const more = el('button', 'project-more');
      more.type = 'button';
      more.dataset.navigationKey = `menu:${key}`;
      more.setAttribute('aria-haspopup', 'menu');
      bindAttribute(more, 'aria-label', () => t('ui.options_du_projet', { value1: name }));
      more.append(icon('more'));
      more.onclick = () => openProjectMenu(p.cwd, more);
      header.append(more);
      entry.append(header, children);
      // Search and archives reveal every match. Outside those views, keep the
      // selected session present even if it is older than the first page.
      const limit = needle || archived ? visible.length : limits.get(key) || PAGE_SIZE;
      const shown = visible.slice(0, limit);
      const selected = visible.find((s) => (s.id ? s.id === sessionId : s.runId === viewRunId));
      if (selected && !shown.includes(selected)) shown.push(selected);
      if (isOpen) {
        for (const s of shown) {
          const active = s.id ? s.id === sessionId : s.runId === viewRunId;
          const item = el('div', `session-row${active ? ' active' : ''}`);
          item.dataset.sessionId = s.id || '';
          item.dataset.projectKey = key;
          item.dataset.pinned = String(Boolean(s.pinned));
          item.dataset.archived = String(Boolean(s.archived));
          const status = conversationActivity(s, projectRuns, unreadIds.includes(s.id));
          item.dataset.activity = status;
          const button = el('button', 'session-select');
          button.type = 'button';
          button.dataset.navigationKey = `session:${s.id || s.runId}`;
          button.setAttribute('aria-current', active ? 'page' : 'false');
          bindAttribute(button, 'title', () => s.title || t('ui.sans_titre'));
          button.append(el('span', 'session-title', () => s.title || t('ui.nouvelle_session')));
          item.dataset.projectColor = folderTint || 'transparent';
          const origin = s.id ? sessionOriginDevice(s.id, sync) : null;
          if (origin) {
            const marker = document.createElement('span');
            marker.className = 'session-origin';
            marker.setAttribute('role', 'img');
            marker.append(icon('monitor'));
            const originColor = typeof origin.color === 'string' ? origin.color.toLowerCase() : '';
            if (originColor && originColor !== 'transparent') marker.style.color = originColor;
            const originName = origin.name || origin.id || '';
            bindAttribute(marker, 'title', () => t('sync.origin_last_on', { value1: originName }));
            bindAttribute(marker, 'aria-label', () => t('sync.origin_last_on', { value1: originName }));
            button.append(marker);
          }
          if (status !== 'idle') button.append(activityDot(status));
          else if (s.pinned) {
            const sessionPin = icon('pin', 'session-pin');
            if (folderTint) sessionPin.style.color = folderTint;
            button.append(sessionPin);
          }
          button.onclick = () =>
            s.runId && !s.id
              ? selectRun(projectRuns.find((r) => r.id === s.runId))
              : selectSession(s.id, s.cwd);
          item.append(button);
          if (!readOnly && s.id && !needle && visible.length > 1) {
            const handle = el('button', 'session-drag-handle');
            handle.type = 'button';
            handle.dataset.navigationKey = `session-drag:${s.id}`;
            bindAttribute(handle, 'aria-label', () => t('projects.drag', { name: s.title || t('ui.nouvelle_session') }));
            bindAttribute(handle, 'title', () => t('sessions.drag_hint'));
            handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
            handle.append(icon('grip'));
            item.append(handle);
          }
          if (!readOnly && s.id) {
            const menu = el('button', 'icon-button session-more');
            menu.type = 'button';
            menu.dataset.navigationKey = `session-menu:${s.id}`;
            menu.setAttribute('aria-haspopup', 'menu');
            bindAttribute(menu, 'aria-label', () =>
              t('common.options', { value1: s.title || t('ui.nouvelle_session') }),
            );
            menu.append(icon('more'));
            menu.onclick = () => openSessionMenu(s.id, menu);
            item.oncontextmenu = (event) => {
              event.preventDefault();
              openSessionMenu(s.id, menu);
            };
            item.append(menu);
          }
          children.append(item);
        }
        if (!visible.length) children.append(text('div', 'project-conversations-empty', 'navigation.empty'));
        if (visible.length > shown.length) {
          const more = text('button', 'project-show-more', 'navigation.show_more');
          more.type = 'button';
          more.dataset.navigationKey = `more:${key}`;
          bindAttribute(more, 'aria-label', () => t('navigation.show_more_project', { name }));
          more.onclick = () => {
            limits.set(key, limit + PAGE_SIZE);
            render();
          };
          children.append(more);
        }
        if (!needle && !archived && limit > PAGE_SIZE) {
          const less = text('button', 'project-show-more', 'navigation.show_less');
          less.type = 'button';
          less.dataset.navigationKey = `less:${key}`;
          less.onclick = () => {
            limits.delete(key);
            render();
          };
          children.append(less);
        }
      }
      root.append(entry);
    }
    if (!rendered) {
      const empty = text(
        'div',
        'sidebar-empty',
        needle
          ? 'ui.aucune_session_ne_correspond_a_votre_recherche'
          : archived
            ? 'ui.aucune_session_archivee'
            : 'ui.vos_projets_au_meme_endroit',
      );
      if (!projects.length && !readOnly) {
        const add = text('button', '', 'ui.ajouter_un_dossier');
        add.onclick = addProject;
        empty.append(add);
      }
      root.append(empty);
    }
    scroller.scrollTop = scroll;
    if (focused)
      [...root.querySelectorAll('[data-navigation-key]')]
        .find((node) => node.dataset.navigationKey === focused)
        ?.focus({ preventScroll: true });
  }
  return {
    render,
    invalidate() {
      signature = '';
    },
    reveal(cwd) {
      setExpanded(cwd, true);
    },
  };
}
