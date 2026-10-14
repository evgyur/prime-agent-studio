// Prime Agent Studio icon set: the app's own line icons (MIT, (c) 2026 zerr0o).
// 24 x 24 viewBox, no fill, stroke currentColor 1.5, round caps and joins. Display at 14 to 18 px.
//
// Classic script (works from file:// too):  <script src="icons.js"></script>  then  StudioIcons.mountIcons();
// ES modules and bundlers:                  import { iconSvg, mountIcons } from './icons.esm.js';
(() => {
  const ICONS = {
    "plus": "M12 5v14M5 12h14", // add, new
    "bell": "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4", // notifications
    "search": "m21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0", // search
    "folder": "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z", // project (fill it with the project color)
    "folder-plus": "M3 7V5h6l2 2h10v13H3V7Zm9 3v7m-3-3.5h6", // add a project
    "branch": "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9", // Git branch
    "archive": "M4 8h16v12H4V8ZM3 3h18v5H3V3Zm7 9h4", // archive
    "settings": "m10 3-.5 2-2 .9-1.8-.6-2 3.4L5.2 10v2l-1.5 1.3 2 3.4 1.8-.6 2 .9.5 2h4l.5-2 2-.9 1.8.6 2-3.4-1.5-1.3v-2l1.5-1.3-2-3.4-1.8.6-2-.9L14 3h-4ZM15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0", // preferences (gear)
    "menu": "M4 6h16M4 12h16M4 18h16", // open the sidebar (mobile)
    "more": "M5 12h.01M12 12h.01M19 12h.01", // more actions (three dots)
    "grip": "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01", // drag handle
    "panel": "M3 4h18v16H3V4Zm12 0v16", // toggle a side panel
    "layout": "M3 4h18v16H3V4Zm11 0v16m0-8h7", // layout
    "map": "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15", // roadmap (map)
    "compass": "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM16 8l-2 6-6 2 2-6 6-2Z", // explore
    "code": "m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16", // code
    "bug": "M8 7V5a4 4 0 0 1 8 0v2M6 7h12v8a6 6 0 0 1-12 0V7Zm6 0v14M2 9h4m12 0h4M2 15h4m12 0h4M4 21l3-3m10 0 3 3", // bug, fix
    "sparkles": "m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Zm8-1v4m-2-2h4", // improve, suggestion
    "arrow-up-right": "M6 18 18 6M6 6h12v12", // open in place
    "arrow-up": "M12 19V5m-6 6 6-6 6 6", // send
    "arrow-down": "M12 5v14m-6-6 6 6 6-6", // scroll to latest
    "model": "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5", // model picker (stacked layers)
    "stop": "M6 6h12v12H6V6", // stop a run
    "shield": "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6", // security, permissions
    "copy": "M9 9h12v12H9V9ZM5 15H3V3h12v2", // copy
    "download": "M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5", // download, export
    "upload": "M12 21V9m-5 5 5-5 5 5M3 16v5h18v-5", // upload, import
    "terminal": "m4 5 6 6-6 6m8 0h8", // terminal, tool activity
    "pencil": "m16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5", // rename, edit
    "pin": "m9 3 12 12-3 3-5-2-4 4-5-5 4-4-2-5 3-3Zm-3 15-4 4", // pin
    "star": "m12 2.8 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9L12 2.8Z", // favorite
    "x": "m6 6 12 12M6 18 18 6", // close
    "moon": "M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z", // dark theme
    "sun": "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 1v2m0 18v2M1 12h2m18 0h2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4", // light theme
    "monitor": "M2 3h20v14H2V3Zm10 14v4m-5 0h10", // system theme, a PC
    "chat": "M21 4H3v13h5l4 4 4-4h5V4Z", // conversation
    "chevron": "m9 5 7 7-7 7", // disclosure (rotate 90deg when open)
    "check": "m5 12 4 4L19 6", // done, success
    "refresh": "M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17", // refresh
    "alert": "m12 3 10 18H2L12 3Zm0 5v6m0 3v.01", // warning
    "user": "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a8 5 0 0 1 16 0v3", // user avatar
    "brain": "M12 4C8 0 4 4 5 7c-5 1-4 7-1 8-1 5 5 8 8 4 3 4 9 1 8-4 3-1 4-7-1-8 1-3-3-7-7-3Zm0 0v15", // reasoning
    "tool": "M21 3a6 6 0 0 1-8 8L5 21l-3-3 9-9a6 6 0 0 1 8-8l-4 4 3 3 3-5Z", // tool settings
    "conversation": "M21 4H3v13h5l4 4 4-4h5V4Z", // conversation tab
    "roadmap": "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15", // Roadmap tab
    "session": "M5 3h10l4 4v14H5V3Zm10 0v5h4M8 12h8M8 16h6", // Session tab
    "agents": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75", // Agents tab
    "files": "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z", // Files tab
    "preferences": "m10 3-.5 2-2 .9-1.8-.6-2 3.4L5.2 10v2l-1.5 1.3 2 3.4 1.8-.6 2 .9.5 2h4l.5-2 2-.9 1.8.6 2-3.4-1.5-1.3v-2l1.5-1.3-2-3.4-1.8.6-2-.9L14 3h-4ZM15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0", // Preferences tab
    "lock": "M7 10.5h10a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5.5a2 2 0 0 1 2-2ZM8 10.5V7a4 4 0 0 1 8 0v3.5", // locked tool tab
    "unlock": "M7 10.5h10a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5.5a2 2 0 0 1 2-2ZM8 10.5V7a4 4 0 0 1 7.8-1.3", // unlocked tool tab
    "machine": "M3 4h18v12H3V4Zm9 12v4m-5 0h10", // a machine (PC running Studio)
    "scan": "M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M7 12h10", // scan a QR code
    "trash": "M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3", // remove
    "image": "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM9.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M3 17l6-6 4 4 3-3 5 5", // attach a photo
    "paperclip": "m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.9-2.9L15 6.5", // attach a file
  };

  /** SVG markup of one icon, as a string. size in px; title makes it a labelled image instead of a decoration. */
  function iconSvg(name, { size = 18, className = 'ps-icon', title = '' } = {}) {
    const d = ICONS[name];
    if (!d) throw new Error(`Unknown icon: ${name}`);
    const label = title ? `role="img" aria-label="${title.replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
    return `<svg class="${className}" ${label} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  }

  /** Replace the content of every [data-icon="name"] element below root, like Studio does. data-size sets the size. */
  function mountIcons(root = document) {
    for (const node of root.querySelectorAll('[data-icon]')) node.innerHTML = iconSvg(node.dataset.icon, { size: Number(node.dataset.size) || 18 });
  }

  /** The Studio brand mark: a "P" stroke drawn on a 32 x 32 grid. Put it inside .ps-brand-mark (lavender tile). */
  const MARK_PATH = 'M9 24V8h10a6 6 0 0 1 0 12h-5v4M14 13h5a1 1 0 1 1 0 2h-5v-2Z';
  const markSvg = (size = 30) =>
    `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none"><path d="${MARK_PATH}" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>`;

  globalThis.StudioIcons = { ICONS, iconSvg, mountIcons, MARK_PATH, markSvg };
})();
