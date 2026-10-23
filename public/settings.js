import { t as tr, translateKnown, translateDOM, onLanguageChange, bindText } from './i18n.js';
import { createDesktopUpdates } from './desktop-updates.js';
import { createInteractionSettings } from './interaction-settings.js';
import { createEngineSettings } from './engine-settings.js';
import { createComputerPreferences } from './computer-preferences.js';
import { createVoiceSettings } from './voice-settings.js';
import { createSyncSettings } from './sync-settings.js';
import { createPublicApiSettings } from './api-settings.js';
import {
  isDesktopComponentsAvailable,
  isNewComponentsBridgeAvailable,
  openDesktopComponents,
  registerDesktopComponentsOpener,
} from './desktop-components-action.js';

export function createSettings({
  api,
  getContext,
  openResources,
  copyText,
  toast,
  onStudioPreferences = () => {},
  onEngineSettings = () => {},
  onComputerPreferences = () => {},
  onVoiceSettings = () => {},
  getModels,
  openModelPicker,
  icon,
  getElement = null,
  domId = null,
  instanceId = '',
  isPrimary = true,
} = {}) {
  const scoped = typeof getElement === 'function';
  const $ = (id) => (scoped ? getElement(id) : document.getElementById(id));
  const scopedId = (logical) => (typeof domId === 'function' ? domId(logical) : logical);
  // Global singleton manager dialogs stay global by design (one live node
  // each); only the initiating instance restores on their close.
  const globalById = (id) => document.getElementById(id);
  const primary = isPrimary !== false;
  const scope = { getElement: scoped ? getElement : null, domId, instanceId, isPrimary };
  const updates = createDesktopUpdates({ api, getContext, ...scope });
  const interactions = createInteractionSettings({ api, getContext, onStudioPreferences, ...scope });
  const engineSettings = createEngineSettings({ api, getContext, onChanged: onEngineSettings, ...scope });
  const computerPreferences = createComputerPreferences({
    api,
    getContext,
    getModels,
    openModelPicker,
    onChanged: onComputerPreferences,
    ...scope,
  });
  computerPreferences.start();
  const voiceSettings = createVoiceSettings({ api, getContext, onChanged: onVoiceSettings, ...scope });
  voiceSettings.start();
  const syncSettings = createSyncSettings({ api, getContext, toast, ...scope });
  const publicApi = createPublicApiSettings({ api, getContext, copyText, toast, icon, ...scope });
  const showLegacyComponentsRow = isDesktopComponentsAvailable() && !isNewComponentsBridgeAvailable();
  if (showLegacyComponentsRow) {
    $('settings-components-row').hidden = false;
    $('settings-components').onclick = () => void openDesktopComponents({ toast });
  }
  const dialog = $('settings-dialog'),
    tabs = [...dialog.querySelectorAll('[data-settings-tab]')];
  if (window.__PRIME_STUDIO_DESKTOP__ === true) {
    const scope = dialog.querySelector('[data-i18n="settings.scope_browser"]');
    scope.dataset.i18n = 'settings.scope_desktop';
    bindText(scope, () => tr('settings.scope_desktop'));
  }
  let selected = 'appearance',
    network,
    busy = false,
    loading = false,
    generation = 0,
    system,
    setupUrl,
    httpsBusy = false,
    returnFrom,
    returnButton,
    dock = null,
    programmaticCloses = 0,
    suppressObserverOnce = false,
    gatedOnce = false,
    lastGateKey = '',
    // Modal popup session: true while a main-entry/boot popup is user-facing
    // (or was released for a node transfer and awaits restore). Dock resyncs
    // never auto-convert it to a tab; the tab is explicit Add Tab only.
    popupOpen = false,
    // Popup visibility over a dock-hidden slot: the layout keeps the node
    // hidden, so the attribute is lifted for the popup session and put back
    // on close. No layout mutation, no tab, no active-tab change.
    hideOnClose = false,
    // Startup intent (?settings=updates): honored once at the first docked
    // handshake even if the modal died before it (e.g. a pre-handshake parent
    // move that bypassed prepareDockMove). Cleared on user cancel and on the
    // handshake itself — never resurrected later.
    bootUpdates = false,
    bootPhase = true,
    disposed = false;
  const node = (tag, className, message) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (message) bindText(element, () => tr(message));
    return element;
  };
  const button = (message, action, className = 'secondary-button') => {
    const element = node('button', className, message);
    element.type = 'button';
    element.onclick = action;
    return element;
  };
  const error = (id, value) => {
    $(id).hidden = !value;
    bindText($(id), () => translateKnown(value || ''));
  };
  function select(id, focus = false, opts = {}) {
    selected = id;
    const refresh = opts.refresh !== false;
    for (const tab of tabs) {
      const active = tab.dataset.settingsTab === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $('settings-panel-' + tab.dataset.settingsTab).hidden = !active;
      if (active && focus) tab.focus();
      if (active && matchMedia('(max-width: 700px)').matches)
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    // Docked visibility resyncs (drag/move/tab toggle) pass { refresh: false } so
    // the selected category and unsaved forms survive without re-fetching.
    if (refresh) {
      if (id === 'remote' && !getContext().readOnly) void refreshNetwork();
      if (id === 'api' && !getContext().readOnly && !getContext().remote) void publicApi.refresh();
      if (id === 'sync' && !getContext().readOnly) void syncSettings.refresh();
      if (id === 'system') {
        void refreshSystem();
        void refreshAutostart();
      }
      if (id === 'updates') void updates.refresh();
      if (id === 'models') {
        void interactions.refreshDefault();
        engineSettings.update();
      }
      if (id === 'tools') {
        computerPreferences.update();
        void computerPreferences.refresh().catch(() => {});
        void voiceSettings.refresh();
      }
      if (id === 'notifications') void interactions.refreshNotifications();
    }
  }
  for (const tab of tabs) tab.onclick = () => select(tab.dataset.settingsTab);
  const narrow = matchMedia('(max-width: 700px)');
  const orientation = () => {
    // Container-aware: a 260px dock pane on a wide desktop never trips the
    // viewport query, so measure the dialog itself while docked. Attribute-only,
    // never re-renders forms (dirty inputs untouched).
    const horizontal = dock ? dialog.getBoundingClientRect().width <= 700 : narrow.matches;
    dialog
      .querySelector('.settings-nav')
      .setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
  };
  narrow.addEventListener('change', orientation);
  const orientationObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => orientation()) : null;
  try {
    orientationObserver?.observe(dialog);
  } catch {}
  orientation();
  dialog.querySelector('.settings-nav').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const visible = tabs.filter((tab) => !tab.hidden),
      index = visible.indexOf(document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? visible.length - 1
          : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + visible.length) %
            visible.length;
    select(visible[next].dataset.settingsTab, true);
  });
  function gateKey() {
    try {
      const context = getContext();
      return [context.readOnly, context.remote, context.projectCwd].join('|');
    } catch {
      return '';
    }
  }
  function safeShowModal() {
    // showModal() throws InvalidStateError on an already-open dialog, modal or
    // not — so never call it open. Non-modal dock display is released silently
    // first (tab registration kept); the counter keeps that close silent. An
    // already-open modal is a no-op.
    if (dialog.open && !dialog.matches?.(':modal')) closeProgrammatic();
    if (!dialog.open) dialog.showModal();
  }
  function showDocked() {
    if (!dock || !dock.visible || dialog.open) return dialog.open;
    suppressObserverOnce = true;
    try {
      // Non-modal only: no inert page, no focus trap. Nested child dialogs keep
      // real showModal() and stack above this surface.
      dialog.show();
    } catch {
      suppressObserverOnce = false;
    }
    return dialog.open;
  }
  function applyGating() {
    const context = getContext();
    for (const tab of tabs)
      tab.hidden =
        (context.readOnly && tab.dataset.settingsTab === 'models') ||
        (context.readOnly && tab.dataset.settingsTab === 'tools') ||
        ((context.readOnly || context.remote) && tab.dataset.settingsTab === 'api') ||
        (context.readOnly && tab.dataset.settingsTab === 'sync');
    if (tabs.find((tab) => tab.dataset.settingsTab === selected)?.hidden) selected = 'appearance';
    const unavailable = !context.projectCwd || context.readOnly;
    $('settings-skills').disabled = $('settings-prompts').disabled = unavailable;
    bindText($('settings-resource-note'), () =>
      tr(unavailable ? 'settings.choose_project' : 'settings.resources_scope'),
    );
    $('settings-logs-row').hidden = context.readOnly;
  }
  function opened() {
    if (!dialog.open) return;
    // A visible popup is a live surface even over a dock-hidden slot: only a
    // closed dialog skips the refresh, never a hidden layout flag.
    if (!dialog.getClientRects().length) return;
    if (dock) {
      const key = gateKey();
      if (gatedOnce && key === lastGateKey) {
        // Drag/move/tab-visibility resync: keep the selected category and all
        // unsaved forms, no re-fetch. A real initial open or a context change
        // still takes the full path below.
        applyGating();
        select(selected, false, { refresh: false });
        return;
      }
      lastGateKey = key;
      gatedOnce = true;
      applyGating();
      select(selected);
      return;
    }
    applyGating();
    select(selected);
  }
  // Parent hook after bootstrap access mode or active-project change: re-apply
  // readOnly/remote gating and re-assert the selected tab WITHOUT refetching,
  // so dirty global forms survive a mere projectCwd change (opened() would
  // full-refresh on a gateKey change and erase them). Safe no-op when closed
  // or dock-hidden. Refreshes the gate marker so the next geometry resync
  // does not refetch for this context change.
  function refreshContext() {
    if (!dialog.open) return;
    if (!dialog.getClientRects().length) return;
    applyGating();
    select(selected, false, { refresh: false });
    lastGateKey = gateKey();
    gatedOnce = true;
  }
  const openObserver = new MutationObserver(() => {
    if (suppressObserverOnce) {
      suppressObserverOnce = false;
      return;
    }
    opened();
  });
  openObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  // dialog.close() queues its close event asynchronously, so a synchronous
  // try/finally flag around close() cannot work. Count programmatic closes
  // instead: increment only when open, so every increment pairs with exactly
  // one close event, and consume one count per event. No timeouts.
  function closeProgrammatic(value) {
    if (!dialog.open) return false;
    programmaticCloses++;
    try {
      dialog.close(value);
    } catch {
      programmaticCloses--;
      return false;
    }
    return true;
  }
  // Called via onBeforeMove before the parent transfers the node: release the
  // top layer when modal. popupOpen already marks the popup session, so the
  // post-move setDocked restores it (modal) or converts it (live tab slot).
  function prepareDockMove() {
    if (dialog.matches?.(':modal')) closeProgrammatic();
  }
  // A popup over a dock-hidden slot must be visible: lift the layout's hidden
  // attribute for the session (put back on close). Ancestor frames stay
  // untouched; the parent re-applies layout hiding on its own renders.
  function revealPopup() {
    if (dock && dialog.hidden) {
      dialog.hidden = false;
      hideOnClose = true;
    }
  }
  // Dynamically tracked children (per-instance resourceOnly commands dialogs
  // supplied by the parent via trackChild) plus the known global singletons.
  // A currently open child means this close is a parent yield, not a user
  // cancel: the return path restores the popup session afterwards.
  const trackedChildren = new Map();
  const childManagerOpen = () =>
    ['model-config-dialog', 'providers-dialog', 'mcp-dialog', 'remote-access-dialog', 'commands-dialog'].some(
      (id) => document.getElementById(id)?.open,
    ) || [...trackedChildren.keys()].some((node) => node?.open);
  const onOwnedClose = () => {
    generation++;
    if (programmaticCloses > 0) {
      programmaticCloses--;
      return;
    }
    // A post-boot user close cancels pending startup intent; the parent's own
    // pre-handshake move (same synchronous boot task) and programmatic closes
    // never do.
    if (bootUpdates && !bootPhase) bootUpdates = false;
    if (popupOpen) {
      // Main/boot popup session ended: restore dock placement when a tab slot
      // is live, never remove the tab (no transient tabs exist by design).
      // A parent yield to a child modal keeps the session: its return path
      // reopens the popup.
      if (childManagerOpen()) return;
      popupOpen = false;
      if (hideOnClose && dock && !dock.visible) dialog.hidden = true;
      hideOnClose = false;
      if (dock && dock.visible) {
        dialog.setAttribute('role', 'region');
        showDocked();
      }
      return;
    }
    // Generic user close (X / data-close-dialog / Esc in classic) while docked
    // removes the dock tab via the parent.
    if (dock) dock.onClose?.();
  };
  dialog.addEventListener('close', onOwnedClose);
  // Return to the category only when this panel launched the child manager.
  const managers = {
    'open-model-config': 'model-config-dialog',
    'open-provider-settings': 'providers-dialog',
    'open-mcp-settings': 'mcp-dialog',
    'open-remote-access': 'remote-access-dialog',
    'settings-skills': 'commands-dialog',
    'settings-prompts': 'commands-dialog',
  };
  const onManagerClick = (event) => {
    // Scoped clones carry rewritten physical ids: resolve the logical id via
    // data-panel-id first so manager launches route from the owning instance.
    const button = event.target.closest('button');
    const logical = button?.getAttribute?.('data-panel-id') || button?.id;
    const manager = managers[logical];
    if (manager) {
      returnFrom = manager;
      returnButton = button;
    }
  };
  dialog.addEventListener('click', onManagerClick, true);
  // One shared close listener per global manager dialog: only the instance
  // that launched it (returnFrom match) restores; siblings stay silent.
  const onManagerClose = (id) => () => {
      if (returnFrom !== id) return;
      const back = returnButton;
      returnFrom = undefined;
      returnButton = undefined;
      if (dock) {
        if (popupOpen) {
          // Nested modal over a main/boot popup: restore the popup session
          // even with no Preferences tab (reveal first, then show).
          revealPopup();
          safeShowModal();
          try {
            back?.focus?.();
          } catch {}
          return;
        }
        // Respect a user-closed pane: never surprise-reopen a panel the user
        // closed while the child modal was open. Focus back only if visible.
        if (!dock.visible) return;
        dock.onOpen?.();
        showDocked();
        try {
          if (dock.visible) back?.focus?.();
        } catch {}
        return;
      }
      safeShowModal();
      back?.focus?.();
    };
  const managerHandlers = new Map();
  for (const id of new Set(Object.values(managers))) {
    const handler = onManagerClose(id);
    managerHandlers.set(id, handler);
    globalById(id)?.addEventListener('close', handler);
  }
  // Per-instance dynamic child (parent-owned resourceOnly commands dialog).
  // The parent calls entry.ui.trackChild(dialog, opener) just before
  // entry.resources.open(source). Only this instance restores on that child's
  // close; siblings stay silent. Preserves popupOpen/dock state, never touches
  // programmaticCloses, removable on dispose or after close.
  function trackChild(childDialog, opener) {
    if (!childDialog || trackedChildren.has(childDialog)) return;
    const handler = () => {
      trackedChildren.delete(childDialog);
      try {
        childDialog.removeEventListener('close', handler);
      } catch {}
      if (disposed) return;
      if (dock) {
        if (popupOpen) {
          revealPopup();
          safeShowModal();
          try {
            opener?.focus?.();
          } catch {}
          return;
        }
        if (!dock.visible) return;
        dock.onOpen?.();
        showDocked();
        try {
          if (dock.visible) opener?.focus?.();
        } catch {}
        return;
      }
      if (!dialog.open) safeShowModal();
      try {
        opener?.focus?.();
      } catch {}
    };
    trackedChildren.set(childDialog, { opener, handler });
    try {
      childDialog.addEventListener('close', handler);
    } catch {}
  }
  for (const [id, source] of [
    ['settings-skills', 'skill'],
    ['settings-prompts', 'prompt'],
  ])
    $(id).onclick = (event) => {
      // Docked: the shared settings node stays open underneath (non-modal); the
      // child dialog stacks as a real modal and returns via trackChild.
      // Classic: close first (the close event fires after the parent opens the
      // child, so the yield guard still sees it open). The opener travels as
      // the 2nd openResources arg for parent trackChild wiring.
      const opener = event?.currentTarget || $(id);
      if (!dock) dialog.close();
      void openResources(source, opener);
    };

  function controlsDisabled(value) {
    $('network-refresh').disabled = value;
    for (const input of $('network-content').querySelectorAll('input, select, button'))
      input.disabled = value || input.dataset.unavailable === 'true';
    $('network-read-only').disabled = value;
    $('open-remote-access').disabled = busy;
    $('network-content').setAttribute('aria-busy', String(value));
  }
  function renderNetwork() {
    if (!network) return;
    const expanded = new Set(
      [...$('network-content').querySelectorAll('details[open]')].map((item) => item.dataset.channel),
    );
    const content = document.createDocumentFragment();
    for (const channel of network.channels) {
      const card = node('div', 'network-card'),
        heading = node('div', 'network-heading'),
        title = node('div');
      const label = node('label', '', 'settings.' + channel.kind);
      label.htmlFor = scopedId('network-' + channel.kind);
      title.append(label, node('p', 'network-description', 'settings.' + channel.kind + '_note'));
      heading.append(title);
      const state = node('span', 'network-state', 'settings.status_' + channel.status);
      state.dataset.status = channel.status;
      if (channel.kind !== 'https') {
        const toggle = node('input', 'switch');
        toggle.id = label.htmlFor;
        toggle.type = 'checkbox';
        toggle.setAttribute('role', 'switch');
        toggle.checked = channel.enabled;
        toggle.dataset.unavailable = String(!channel.addresses.length && !channel.enabled);
        toggle.disabled = toggle.dataset.unavailable === 'true';
        const control = node('div', 'network-toggle');
        control.append(state, toggle);
        heading.append(control);
        card.append(heading);
        const details = node('details', 'network-advanced');
        details.dataset.channel = channel.kind;
        details.open = expanded.has(channel.kind);
        details.append(node('summary', '', 'settings.connection_options'));
        const fields = node('div', 'network-fields');
        const addressLabel = node('label', '', 'settings.interface'),
          address = node('select');
        address.id = scopedId('network-address-' + channel.kind);
        addressLabel.htmlFor = address.id;
        for (const item of channel.addresses)
          address.add(new Option(`${item.name} · ${item.address}`, item.address));
        if (channel.addresses.some((item) => item.address === channel.host)) address.value = channel.host;
        address.disabled = !channel.addresses.length;
        address.dataset.unavailable = String(address.disabled);
        const portLabel = node('label', '', 'settings.port'),
          port = node('input');
        port.id = scopedId('network-port-' + channel.kind);
        portLabel.htmlFor = port.id;
        port.type = 'number';
        port.required = true;
        port.min = '1024';
        port.max = '65535';
        port.step = '1';
        port.value = channel.port;
        const save = (enabled) => {
          toggle.checked = channel.enabled;
          if (enabled && !port.reportValidity()) return;
          void changeNetwork({
            channel: channel.kind,
            enabled,
            host: address.value,
            port: Number(port.value),
          });
        };
        toggle.onchange = () => save(toggle.checked);
        const apply = button('settings.apply', () => save(true));
        apply.dataset.unavailable = String(!channel.addresses.length);
        apply.disabled = !channel.addresses.length;
        const addressGroup = node('div'),
          portGroup = node('div');
        addressGroup.append(addressLabel, address);
        portGroup.append(portLabel, port);
        fields.append(addressGroup, portGroup, apply);
        details.append(fields, node('p', 'settings-footnote', 'settings.port_note'));
        if (!channel.addresses.length)
          card.append(node('p', 'network-hint', 'settings.' + channel.kind + '_missing'));
        if (channel.error) {
          const problem = node('p', 'network-problem');
          bindText(problem, () => translateKnown(channel.error));
          card.append(problem);
        }
        if (channel.url) card.append(connection(channel));
        card.append(details);
      } else {
        const toggle = node('input', 'switch');
        toggle.id = scopedId('network-https');
        toggle.type = 'checkbox';
        toggle.setAttribute('role', 'switch');
        toggle.checked = channel.enabled;
        const control = node('div', 'network-toggle');
        control.append(state, toggle);
        heading.append(control);
        card.append(heading);
        const details = node('details', 'network-advanced');
        details.dataset.channel = 'https';
        details.open = expanded.has('https');
        details.append(node('summary', '', 'settings.connection_options'));
        const fields = node('div', 'network-fields https-fields');
        const portGroup = node('div'),
          portLabel = node('label', '', 'https.local_port'),
          port = node('input');
        port.id = scopedId('network-port-https');
        portLabel.htmlFor = port.id;
        port.type = 'number';
        port.required = true;
        port.min = '1024';
        port.max = '65535';
        port.value = channel.port || 3090;
        const apply = (enabled = true) => {
          toggle.checked = channel.enabled;
          if (enabled && !port.reportValidity()) return;
          void changeNetwork({ channel: 'https', enabled, port: Number(port.value) });
        };
        toggle.onchange = () => apply(toggle.checked);
        portGroup.append(portLabel, port);
        fields.append(
          portGroup,
          button('settings.apply', () => apply()),
        );
        details.append(fields, node('p', 'settings-footnote', 'https.port_note'));
        if (httpsBusy) card.append(node('p', 'https-progress', 'https.activating'));
        if (setupUrl) {
          const guidance = node('div', 'https-guidance');
          guidance.setAttribute('role', 'status');
          guidance.append(node('p', '', 'https.approval_note'));
          const actions = node('div', 'network-link-actions'),
            link = node('a', 'secondary-button', 'https.open_tailscale');
          link.href = setupUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          actions.append(
            link,
            button('https.retry', () => apply()),
          );
          guidance.append(actions);
          card.append(guidance);
        } else if (!channel.enabled) card.append(node('p', 'network-hint', 'https.intro'));
        if (channel.url) card.append(connection(channel));
        if (channel.error) {
          const p = node('p', 'network-problem');
          bindText(p, () => translateKnown(channel.error));
          card.append(p);
        }
        if (channel.enabled && channel.status === 'error') card.append(button('https.retry', () => apply()));
        card.append(details);
      }
      content.append(card);
    }
    $('network-content').replaceChildren(content);
    $('network-security').hidden = !network.configured;
    $('network-read-only').value = String(network.readOnly);
    controlsDisabled(busy);
  }
  function connection(channel) {
    const row = node('div', 'network-connection'),
      address = node('code', 'network-url');
    address.textContent = channel.url;
    const actions = node('div', 'network-link-actions');
    actions.append(
      button('settings.copy_link', () => void copyText(channel.url)),
      button('settings.qr', () => void showQr(channel)),
    );
    row.append(address, actions);
    return row;
  }
  async function refreshNetwork({ silent = false } = {}) {
    if (getContext().readOnly) return;
    if (getContext().readOnly || busy || loading) return;
    loading = true;
    const turn = generation;
    if (!silent) {
      error('network-error');
      controlsDisabled(true);
    }
    try {
      const next = await api('/api/remote-access/network');
      if (turn !== generation) return;
      const changed = JSON.stringify(network) !== JSON.stringify(next);
      network = next;
      if (changed || !silent) renderNetwork();
      error('network-error');
    } catch (e) {
      if (turn === generation) {
        if (!network) $('network-content').replaceChildren();
        error('network-error', e.message);
      }
    } finally {
      loading = false;
      if (turn === generation) controlsDisabled(busy);
      else if (dialog.open && selected === 'remote') void refreshNetwork();
    }
  }
  async function changeNetwork(body) {
    if (busy || !network || getContext().readOnly) return;
    busy = true;
    httpsBusy = body.channel === 'https' && body.enabled;
    if (body.channel === 'https') setupUrl = undefined;
    // Keep the form values while displaying progress for the potentially slower Serve setup.
    if (httpsBusy) {
      const progress = node('p', 'https-progress', 'https.activating');
      progress.setAttribute('role', 'status');
      $('network-https')?.closest('.network-card').append(progress);
    }
    controlsDisabled(true);
    error('network-error');
    try {
      const next = await api('/api/remote-access/network', {
        method: 'POST',
        body: { ...body, revision: network.revision },
      });
      const { generatedCode, ...state } = next;
      network = state;
      httpsBusy = false;
      if (generatedCode) {
        $('network-generated-code').textContent = generatedCode;
        $('network-new-code').hidden = false;
      }
      renderNetwork();
      if (generatedCode && dialog.open && selected === 'remote') $('network-copy-code').focus();
      toast(() =>
        tr(
          body.channel === 'permissions'
            ? 'settings.permissions_saved'
            : body.channel === 'https' && body.enabled
              ? 'https.saved'
              : 'settings.network_saved',
        ),
      );
    } catch (e) {
      httpsBusy = false;
      try {
        const link = new URL(e.setupUrl);
        if (
          link.protocol === 'https:' &&
          link.hostname === 'login.tailscale.com' &&
          !link.port &&
          !link.username &&
          !link.password
        )
          setupUrl = link.href;
      } catch {}
      // Keep the last working controls; refresh a conflict so the next action is deliberate.
      try {
        network = await api('/api/remote-access/network');
      } catch {}
      renderNetwork();
      error('network-error', e.message);
    } finally {
      busy = false;
      httpsBusy = false;
      controlsDisabled(false);
    }
  }
  $('network-refresh').onclick = () => void refreshNetwork();
  $('network-read-only').onchange = () => {
    const readOnly = $('network-read-only').value === 'true';
    $('network-read-only').value = String(network.readOnly);
    void changeNetwork({ channel: 'permissions', readOnly });
  };
  $('network-copy-code').onclick = () => void copyText($('network-generated-code').textContent);
  $('network-dismiss-code').onclick = () => {
    $('network-generated-code').textContent = '';
    $('network-new-code').hidden = true;
  };
  // Owned poller: only this dialog's open remote tab refreshes. Disposed with
  // the instance, so clones never stack duplicate network polls.
  const networkTimer = setInterval(() => {
    if (disposed) return;
    if (
      dialog.open &&
      dialog.getClientRects().length &&
      selected === 'remote' &&
      document.visibilityState === 'visible' &&
      !$('network-content').contains(document.activeElement)
    )
      void refreshNetwork({ silent: true });
  }, 8000);

  const qrDialog = node('dialog', 'modal settings-qr');
  qrDialog.id = scopedId('settings-qr-dialog');
  qrDialog.setAttribute('data-panel-id', 'settings-qr-dialog');
  qrDialog.setAttribute('aria-labelledby', scopedId('settings-qr-title'));
  const qrHeading = node('div', 'modal-heading'),
    qrTitle = node('h2', '', 'settings.qr_title');
  qrTitle.id = scopedId('settings-qr-title');
  const qrClose = button('ui.fermer', () => qrDialog.close(), 'secondary-button');
  qrHeading.append(qrTitle, qrClose);
  const qrStatus = node('p'),
    qrImage = node('img'),
    qrUrl = node('code', 'network-url');
  qrImage.width = qrImage.height = 256;
  qrImage.alt = '';
  qrDialog.append(qrHeading, qrStatus, qrImage, qrUrl, node('p', 'settings-footnote', 'settings.qr_note'));
  document.body.append(qrDialog);
  let qrGeneration = 0;
  qrDialog.addEventListener('close', () => {
    qrGeneration++;
    qrImage.removeAttribute('src');
  });
  async function showQr(channel) {
    const turn = ++qrGeneration;
    qrImage.hidden = true;
    qrUrl.textContent = '';
    bindText(qrStatus, () => tr('settings.loading'));
    qrDialog.showModal();
    try {
      const result = await api('/api/remote-access/qr?channel=' + channel.kind);
      if (turn !== qrGeneration) return;
      qrImage.src = result.image;
      qrImage.hidden = false;
      qrUrl.textContent = result.url;
      bindText(qrStatus, () =>
        tr(channel.kind === 'lan' ? 'settings.qr_scan_lan' : 'settings.qr_scan_tailscale'),
      );
    } catch (e) {
      if (turn === qrGeneration) bindText(qrStatus, () => translateKnown(e.message));
    }
  }
  async function refreshSystem() {
    const turn = generation;
    error('settings-system-error');
    system = undefined;
    try {
      const context = getContext();
      system = context.readOnly ? { runtime: context.version, remote: true } : await api('/api/system');
      if (turn !== generation) return;
      const list = $('settings-system-info');
      list.replaceChildren();
      const values = [
        ['settings.studio_version', system.studio],
        [
          'settings.engine',
          system.runtime?.available ? tr('settings.available') : tr('settings.unavailable'),
        ],
        ['settings.engine_version', system.runtime?.version],
        ['settings.running', system.activeRuns],
        ['settings.node', system.node],
      ];
      for (const [label, value] of values)
        if (value !== undefined && value !== null) {
          const dt = node('dt', '', label),
            dd = node('dd');
          dd.textContent = String(value);
          list.append(dt, dd);
        }
    } catch (e) {
      if (turn === generation) error('settings-system-error', e.message);
    }
  }
  function isAutostartAvailable() {
    try {
      const context = getContext();
      // Desktop-only Tauri bridge: remote browsers never have it, so they stay hidden.
      if (context?.readOnly === true) return false;
    } catch {
      return false;
    }
    return isNewComponentsBridgeAvailable();
  }
  async function refreshAutostart() {
    const row = $('settings-autostart-row');
    const input = $('settings-autostart');
    if (!row || !input) return;
    if (!isAutostartAvailable()) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    input.disabled = true;
    let known = false;
    try {
      const state = await window.__TAURI__.core.invoke('desktop_state');
      known = typeof state?.autostart === 'boolean';
      if (known) input.checked = state.autostart;
    } catch {
      // Keep the last value, but do not present an unreadable setting as on or off.
    } finally {
      input.indeterminate = !known;
      input.disabled = !known;
      const note = row.querySelector('p[data-i18n]');
      if (note) {
        const key = known ? 'settings.autostart_note' : 'settings.autostart_unavailable';
        note.dataset.i18n = key;
        bindText(note, () => t(key));
      }
    }
  }
  const autostartInput = $('settings-autostart');
  if (autostartInput) {
    autostartInput.onchange = async () => {
      if (!isAutostartAvailable()) {
        $('settings-autostart').checked = !$('settings-autostart').checked;
        return;
      }
      const input = $('settings-autostart');
      const wanted = input.checked;
      input.disabled = true;
      error('settings-system-error');
      try {
        await window.__TAURI__.core.invoke('desktop_autostart', { enabled: wanted });
        error('settings-system-error');
      } catch (e) {
        input.checked = !wanted;
        error('settings-system-error', e?.message || 'settings.autostart_error');
      } finally {
        input.disabled = false;
      }
    };
  }
  $('settings-copy-diagnostics').onclick = async () => {
    await refreshSystem();
    if (system)
      void copyText(
        JSON.stringify(
          {
            studio: system.studio,
            node: system.node,
            platform: system.platform,
            engine: { available: system.runtime?.available, version: system.runtime?.version },
            activeRuns: system.activeRuns,
          },
          null,
          2,
        ),
      );
  };
  $('settings-open-logs').onclick = async () => {
    const control = $('settings-open-logs');
    control.disabled = true;
    try {
      await api('/api/system/logs', { method: 'POST', body: {} });
    } catch (e) {
      error('settings-system-error', e.message);
    } finally {
      control.disabled = false;
    }
  };
  // Text bindings update in place, preserving open connection options and unsaved fields.
  const offLanguage = onLanguageChange(() => {
    if (!disposed && dialog.open && (!dock || dock.visible) && selected === 'system')
      void refreshSystem();
  });
  translateDOM(dialog);
  // Opens straight on one tab: the previously selected tab is not refreshed first.
  // Docked: route through the parent (same dock identity), keep the node non-modal.
  const openTab = (id) => {
    selected = id;
    if (dock) {
      dock.onOpen?.();
      if (!dock.visible) return;
      showDocked();
      select(id);
      return;
    }
    if (!dialog.open) safeShowModal();
    else select(id);
  };
  const openUpdatesPane = (focus) => {
    if (dock) {
      dock.onOpen?.();
      if (!dock.visible) return;
      showDocked();
      select('updates', Boolean(focus));
      return;
    }
    if (!dialog.open) safeShowModal();
    select('updates', Boolean(focus));
  };
  const openComponentPanel = () => {
    openUpdatesPane(false);
    const reveal = () => {
      try {
        const panel = $('studio-update-components');
        const heading = $('studio-update-components-heading');
        if (panel && !panel.hidden) panel.scrollIntoView({ block: 'start' });
        if (heading) heading.focus({ preventScroll: true });
      } catch {}
    };
    // One layout frame after revealing the tab; never steal focus again later.
    requestAnimationFrame(() => {
      if (!disposed && dialog.open && selected === 'updates') reveal();
    });
  };
  // Global desktop surface hooks belong to the primary only: a single
  // components opener, a single boot deep-link, no N duplicate registrations.
  if (primary) registerDesktopComponentsOpener(() => openComponentPanel());
  try {
    if (primary) window.__PRIME_STUDIO_OPEN_UPDATES__ = () => openComponentPanel();
  } catch {}
  if (primary && new URLSearchParams(location.search).get('settings') === 'updates') {
    selected = 'updates';
    bootUpdates = true;
    // Boot intent is a popup session like the main entry (never an auto tab).
    popupOpen = true;
    dialog.removeAttribute('role');
    revealPopup();
    safeShowModal();
    const url = new URL(location.href);
    url.searchParams.delete('settings');
    history.replaceState(null, '', url);
  }
  // End of the synchronous boot task: anything closing the dialog afterwards
  // is a user cancel (clearing startup intent), never the boot handoff itself.
  queueMicrotask(() => {
    bootPhase = false;
  });
  // Refresh autostart visibility once context is known, without overriding the system tab state.
  void refreshAutostart().catch(() => {});
  // Docking contract (mirrors roadmapUI.setDocked). The parent owns the move:
  // app delegates Preferences onBeforeMove to prepareDockMove (releases the
  // top layer when modal), then the parent calls setDocked after transfer.
  // One existing #settings-dialog DOM:
  // non-modal show() only while docked-visible, closed when invisible or on
  // classic restore, showModal() classic only. The `dock !== null` gates in the
  // child-open branches above stay dormant until the parent calls setDocked.
  function setDocked(next) {
    const wasDocked = dock !== null;
    dock = next || null;
    // Already classic: strict no-op. Never touch a classic modal (deep-link or
    // otherwise) on a parent resync.
    if (!dock && !wasDocked) return;
    if (!dock) {
      // Actual exit to classic. An open popup stays open as a classic modal;
      // otherwise release dock display silently (or restore a popup released
      // for an undock transfer).
      dialog.removeAttribute('role');
      if (dialog.matches?.(':modal')) return;
      if (popupOpen) {
        popupOpen = false;
        safeShowModal();
        popupOpen = dialog.open;
      } else closeProgrammatic();
      gatedOnce = false;
      lastGateKey = '';
      return;
    }
    // A visible modal popup is never auto-docked: the main entry and boot
    // intent stay modal across transfers and resizes; only explicit Add Tab
    // (on a closed dialog) ever shows tab display.
    if (dialog.matches?.(':modal') && dialog.getClientRects().length) {
      if (bootUpdates) {
        bootUpdates = false;
        applyGating();
        select('updates');
      }
      popupOpen = true;
      return;
    }
    // Remaining here: a closed dialog, or a parked (invisible) modal that can
    // never serve as a popup. Startup intent or a released popup session is
    // restored as a visible popup in place — never converted to a tab, never
    // adding layout. Consumed here once; later resyncs and user-cancelled
    // boots never reopen.
    if (bootUpdates || popupOpen) {
      const boot = bootUpdates;
      bootUpdates = false;
      popupOpen = false;
      if (dialog.open) closeProgrammatic();
      dialog.removeAttribute('role');
      revealPopup();
      safeShowModal();
      popupOpen = dialog.open;
      // Boot navigation opens fresh on Updates; a restored popup keeps state.
      if (boot && dialog.open) select(selected);
      return;
    }
    // Embedded settings tab display: no inert page, no focus trap. The region
    // role fits a tab-embedded panel; classic restore removes it above.
    dialog.setAttribute('role', 'region');
    if (!dock.visible) {
      closeProgrammatic();
      return;
    }
    if (dialog.open) {
      // Resync after drag/move: opened() takes the cheap gated path and keeps
      // dirty inputs (gatedOnce + unchanged key).
      opened();
      return;
    }
    // Real (re)open while visible: the observer is suppressed for this one
    // programmatic show; opened() runs explicitly for full gating + refresh.
    suppressObserverOnce = true;
    try {
      dialog.show();
    } catch {
      suppressObserverOnce = false;
      return;
    }
    opened();
  }
  // Main entry is ALWAYS a modal popup, even when docked. One live node:
  // release dock display silently first (tab registration kept), reveal a
  // dock-hidden slot, then show. Never adds a tab or moves the node.
  function openPopup(tab) {
    if (tab) selected = tab;
    if (!dialog.matches?.(':modal')) {
      dialog.removeAttribute('role');
      revealPopup();
      safeShowModal();
    } else if (tab) select(tab);
    popupOpen = dialog.open;
  }
  // Native tray entry. A raw showModal() from the shell would skip
  // revealPopup(): a dock-hidden dialog then stays display:none while the
  // whole page is inert, so the window looks frozen. Always use this path.
  try {
    if (primary) window.__PRIME_STUDIO_OPEN_PREFERENCES__ = (tab) => openPopup(tab || 'updates');
  } catch {}
  return {
    open: () => openPopup(),
    dismiss: () => {
      returnFrom = undefined;
      returnButton = undefined;
      // Explicit dismiss cancels pending startup intent like a user close,
      // and ends any popup session so a notification cancel stays shut.
      bootUpdates = false;
      popupOpen = false;
      if (dock) {
        // Route through the close listener so the parent removes the dock tab
        // exactly once (no double onClose).
        if (dialog.open) dialog.close('cancel');
        else dock.onClose?.();
        return;
      }
      dialog.close('cancel');
    },
    setDocked,
    prepareDockMove,
    refreshContext,
    trackChild,
    openUpdates: () => openUpdatesPane(false),
    openTab,
    updates,
    getComputerBackend: () => computerPreferences.getBackend(),
    getComputerModel: () => computerPreferences.getModel(),
    getComputerThinking: () => computerPreferences.getThinking(),
    refreshComputerPreferences: () => computerPreferences.refresh(),
    get root() {
      return dialog;
    },
    get instanceId() {
      return instanceId;
    },
    get isPrimary() {
      return primary;
    },
    dispose: () => {
      // Tear down ONLY this instance: stale-guard flights, stop the owned
      // poller, drop owned observers/listeners, dispose children, remove the
      // owned QR node. Global manager dialogs and shared services untouched.
      disposed = true;
      generation++;
      try {
        clearInterval(networkTimer);
      } catch {}
      try {
        openObserver.disconnect();
      } catch {}
      try {
        orientationObserver?.disconnect();
      } catch {}
      try {
        narrow.removeEventListener('change', orientation);
      } catch {}
      try {
        dialog.removeEventListener('close', onOwnedClose);
      } catch {}
      try {
        dialog.removeEventListener('click', onManagerClick, true);
      } catch {}
      for (const [id, handler] of managerHandlers)
        try {
          globalById(id)?.removeEventListener('close', handler);
        } catch {}
      managerHandlers.clear();
      for (const [node, entry] of trackedChildren)
        try {
          node?.removeEventListener?.('close', entry?.handler);
        } catch {}
      trackedChildren.clear();
      try {
        offLanguage?.();
      } catch {}
      for (const child of [updates, interactions, engineSettings, computerPreferences, voiceSettings, syncSettings, publicApi])
        try {
          child?.dispose?.();
        } catch {}
      try {
        qrDialog.remove();
      } catch {}
    },
  };
}
