import { t, bindText } from './i18n.js';

let library;
function webauthn() {
  if (!library) library = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/vendor/passkeys.js';
    script.onload = () => resolve(window.SimpleWebAuthnBrowser);
    script.onerror = () => { library = null; script.remove(); reject(new Error(t('passkeys.failed'))); };
    document.head.append(script);
  });
  return library;
}
async function request(path, body) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || t('passkeys.failed')); return data;
  } finally { clearTimeout(timeout); }
}
const supported = () => window.isSecureContext && !!window.PublicKeyCredential;
const login = document.getElementById('passkey-login');
if (login && supported()) {
  login.hidden = false; bindText(login, () => t('passkeys.login'));
  login.onclick = async () => {
    login.disabled = true; const status = document.getElementById('passkey-login-status');
    bindText(status, () => t('passkeys.waiting'));
    try {
      const browser = await webauthn(), challenge = await request('/lan/passkeys/login-options', {});
      const response = await browser.startAuthentication({ optionsJSON: challenge.optionsJSON });
      await request('/lan/passkeys/login-verify', { id: challenge.id, response });
      location.assign('/');
    } catch (error) { status.textContent = error.name === 'NotAllowedError' ? t('passkeys.cancelled') : error.message; }
    finally { login.disabled = false; }
  };
}

// Cross-instance fan-out: a confirmed register/revoke in one Preferences owner
// refreshes every other live owner form. Forms (busy/deleting/drafts) stay
// local; only confirmed server state is shared, via re-fetch.
const passkeyRefreshListeners = new Set();
function notifyPasskeyInstances(except) {
  for (const fn of [...passkeyRefreshListeners]) {
    if (fn === except) continue;
    try {
      fn();
    } catch {}
  }
}

export function createPasskeySettings({
  getContext,
  getElement = null,
  domId = null,
  instanceId = '',
  isPrimary = true,
} = {}) {
  void domId;
  void instanceId;
  void isPrimary;
  const scoped = typeof getElement === 'function';
  const $ = (id) => (scoped ? getElement('passkey-' + id) : document.getElementById('passkey-' + id));
  const byId = (logical) => (scoped ? getElement(logical) : document.getElementById(logical));
  const dialog = $('dialog'), form = $('form');
  const panel = byId('settings-panel-remote');
  const ownerDialog = byId('settings-dialog');
  if (!dialog || !form) return { refresh: async () => {}, root: null, dispose: () => {} };
  let busy = false, deleting, generation = 0, disposed = false;
  const observers = [];
  async function refresh() {
    if (disposed) return;
    const turn = generation;
    const { remote, readOnly } = getContext();
    $('add').hidden = !remote || readOnly || !supported() || location.protocol !== 'https:';
    bindText($('hint'), () => t(remote ? supported() && location.protocol === 'https:' ? 'passkeys.intro' : 'passkeys.https' : 'passkeys.desktop'));
    $('list').replaceChildren();
    try {
      const data = await request(remote ? '/lan/passkeys/list' : '/api/passkeys');
      if (disposed || turn !== generation) return;
      if (!data.keys.length) bindText($('status'), () => t('passkeys.none')); else $('status').textContent = '';
      for (const key of data.keys) {
        const row = document.createElement('div'); row.className = 'passkey-row';
        const title = document.createElement('span'); title.textContent = key.name;
        row.append(title);
        if (!remote) {
          const remove = document.createElement('button'); remove.className = 'text-button'; remove.type = 'button';
          bindText(remove, () => t('passkeys.revoke')); remove.onclick = () => open(key);
          row.append(remove);
        }
        $('list').append(row);
      }
    } catch (error) {
      if (disposed || turn !== generation) return;
      $('status').textContent = error.message;
    }
  }
  passkeyRefreshListeners.add(refresh);
  function open(key) {
    deleting = key; form.reset(); $('error').textContent = '';
    $('fields').hidden = $('fields').disabled = !!key;
    bindText($('title'), () => t(key ? 'passkeys.revoke' : 'passkeys.add'));
    bindText($('note'), () => key ? t('passkeys.revokeNote', { name: key.name }) : t('passkeys.registerNote'));
    bindText($('submit'), () => t(key ? 'passkeys.revoke' : 'passkeys.add'));
    dialog.showModal(); (key ? $('cancel') : $('name')).focus();
  }
  const onSubmit = async event => {
    event.preventDefault(); if (busy || disposed) return; busy = true;
    const turnAlive = generation;
    $('submit').disabled = $('cancel').disabled = true; $('error').textContent = '';
    try {
      if (deleting) await request('/api/passkeys/revoke', { id: deleting.id });
      else {
        const browser = await webauthn();
        const challenge = await request('/lan/passkeys/register-options', { name: $('name').value.trim(), code: $('code').value });
        $('code').value = '';
        const response = await browser.startRegistration({ optionsJSON: challenge.optionsJSON });
        await request('/lan/passkeys/register-verify', { id: challenge.id, response });
      }
      dialog.close(); await refresh(); notifyPasskeyInstances(refresh);
    } catch (error) {
      if (disposed || turnAlive !== generation) return;
      $('error').textContent = error.name === 'NotAllowedError' ? t('passkeys.cancelled') : error.message;
    }
    finally { busy = false; $('code').value = ''; $('submit').disabled = $('cancel').disabled = false; }
  };
  form.onsubmit = onSubmit;
  const onAdd = () => open();
  const onCancel = () => dialog.close();
  const onCancelEvent = event => { if (busy) event.preventDefault(); };
  const onClose = () => { if (!disposed) { try { $('code').value = ''; } catch {} } };
  if ($('add')) $('add').onclick = onAdd;
  if ($('cancel')) $('cancel').onclick = onCancel;
  dialog.addEventListener('cancel', onCancelEvent);
  dialog.addEventListener('close', onClose);
  // Observe ONLY the owned panel/dialog nodes. The parent clones the pristine
  // #passkey-dialog (outside settings-dialog) with the same instance prefix
  // before this factory runs, so getElement resolves the owned clone. The
  // parent owns append/remove; dispose disconnects and gates stale requests.
  if (panel) {
    const panelObserver = new MutationObserver(() => { if (!panel.hidden) void refresh(); });
    panelObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    observers.push(panelObserver);
  }
  if (ownerDialog) {
    const dialogObserver = new MutationObserver(() => {
      if (ownerDialog.open && panel && !panel.hidden) void refresh();
    });
    dialogObserver.observe(ownerDialog, { attributes: true, attributeFilter: ['open'] });
    observers.push(dialogObserver);
  }
  return {
    refresh,
    get root() {
      return byId('settings-dialog');
    },
    dispose: () => {
      disposed = true;
      generation++;
      passkeyRefreshListeners.delete(refresh);
      for (const observer of observers) {
        try {
          observer.disconnect();
        } catch {}
      }
      observers.length = 0;
      try {
        dialog.removeEventListener('cancel', onCancelEvent);
      } catch {}
      try {
        dialog.removeEventListener('close', onClose);
      } catch {}
      for (const id of ['add', 'cancel']) {
        try {
          const control = $(id);
          if (control) control.onclick = null;
        } catch {}
      }
      try {
        form.onsubmit = null;
      } catch {}
      try {
        $('code').value = '';
      } catch {}
    },
  };
}
