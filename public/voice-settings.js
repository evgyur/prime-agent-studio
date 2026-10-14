import { t as tr, bindText, translateKnown, onLanguageChange } from './i18n.js';

// Preferences > Tools > Voice messages. Machine-local settings stored by the
// server (/api/voice/settings). The Groq key is the provider key managed in
// Providers; this panel only reports whether it is present.
export function createVoiceSettings({
  api,
  getContext = () => ({}),
  getElement = null,
  onChanged = () => {},
} = {}) {
  const $ = (id) => (typeof getElement === 'function' ? getElement(id) : document.getElementById(id));
  let data = null;
  let busy = false;
  let generation = 0;
  let offLanguage = null;

  const locked = () => {
    try {
      return getContext()?.readOnly === true;
    } catch {
      return false;
    }
  };

  function keyText() {
    if (!data || data.provider !== 'groq') return '';
    if (data.keySource === 'providers') return tr('voice.keyProviders');
    if (data.keySource === 'environment') return tr('voice.keyEnvironment');
    return tr('voice.keyMissing');
  }

  function showError(message) {
    const box = $('voice-settings-error');
    if (!box) return;
    box.hidden = !message;
    bindText(box, () => (message ? translateKnown(message) : ''));
  }

  function render() {
    const row = $('voice-settings');
    if (!row) return;
    row.hidden = locked();
    const provider = data?.provider || '';
    const disabled = busy || !data || locked();
    const fields = {
      'voice-provider': provider,
      'voice-groq-model': data?.groqModel,
      'voice-timeout': String(data?.timeoutMs ?? ''),
    };
    for (const [id, value] of Object.entries(fields)) {
      const select = $(id);
      if (!select) continue;
      select.disabled = disabled;
      if (value !== undefined && select.value !== value) select.value = value;
    }
    const url = $('voice-whisper-url');
    if (url) {
      url.disabled = disabled;
      // Never overwrite what the user is typing.
      if (document.activeElement !== url && data) url.value = data.whisperUrl;
    }
    $('voice-groq-fields').hidden = provider !== 'groq';
    $('voice-whisper-fields').hidden = provider !== 'whisper';
    $('voice-timeout-field').hidden = !provider;
    $('voice-auto-send-field').hidden = !provider;
    const autoSend = $('voice-auto-send');
    autoSend.disabled = disabled;
    autoSend.checked = data?.autoSend !== false;
    const status = $('voice-key-status');
    if (status) {
      status.classList.toggle('voice-key-missing', provider === 'groq' && !data?.keySource);
      bindText(status, keyText);
    }
    const open = $('voice-open-providers');
    if (open) open.disabled = locked();
  }

  async function refresh() {
    if (locked()) return render();
    const turn = ++generation;
    try {
      const next = await api('/api/voice/settings');
      if (turn !== generation) return;
      data = next;
      showError(false);
    } catch (error) {
      if (turn !== generation) return;
      showError(error?.message || 'voice.settingsError');
    }
    render();
  }

  async function save(patch) {
    if (busy || locked() || !data) return false;
    const turn = ++generation;
    busy = true;
    render();
    try {
      const next = await api('/api/voice/settings', { method: 'PATCH', body: patch });
      if (turn === generation) data = next;
      showError(false);
      try {
        await onChanged(next);
      } catch {}
      return true;
    } catch (error) {
      showError(error?.message || 'voice.settingsError');
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  function start() {
    $('voice-provider').onchange = (event) => void save({ provider: event.target.value });
    $('voice-groq-model').onchange = (event) => void save({ groqModel: event.target.value });
    $('voice-timeout').onchange = (event) => void save({ timeoutMs: Number(event.target.value) });
    $('voice-auto-send').onchange = (event) => void save({ autoSend: event.target.checked });
    const url = $('voice-whisper-url');
    const commit = () => {
      const value = url.value.trim();
      if (data && value !== data.whisperUrl) void save({ whisperUrl: value });
    };
    url.onchange = commit;
    url.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    };
    // Same instance-scoped launcher as Models > Providers, so closing the
    // providers dialog returns here and the key status refreshes.
    $('voice-open-providers').onclick = () => {
      document
        .getElementById('providers-dialog')
        ?.addEventListener('close', () => void refresh().then(() => onChanged(data)), { once: true });
      $('open-provider-settings')?.click();
    };
    try {
      offLanguage = onLanguageChange(render);
    } catch {}
    render();
  }

  return {
    start,
    refresh,
    update: render,
    dispose() {
      generation++;
      try {
        offLanguage?.();
      } catch {}
    },
  };
}
