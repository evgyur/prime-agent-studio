import { t as tr, bindText, bindAttribute } from './i18n.js';

const MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

// A single recording dialog serves every composer, but the origin is captured
// by the caller. The caller decides whether that exact conversation can send.
export function createVoiceUI({ capture, current, bindingCurrent, insert, submit, canRecord }) {
  let config = null;
  let operation = null;
  const buttons = new Map();
  const dialog = document.createElement('dialog');
  dialog.className = 'voice-dialog';
  dialog.setAttribute('aria-labelledby', 'voice-dialog-title');
  dialog.innerHTML = `
    <div class="voice-dialog-heading"><h2 id="voice-dialog-title"></h2><span class="voice-elapsed">0:00</span></div>
    <p class="voice-provider"></p>
    <p class="voice-status" role="status" aria-live="polite"></p>
    <p class="voice-preview" hidden></p>
    <div class="voice-actions">
      <button type="button" class="secondary-button voice-cancel"></button>
      <button type="button" class="secondary-button voice-insert" hidden></button>
      <button type="button" class="primary-button voice-send" disabled></button>
    </div>`;
  document.body.append(dialog);
  const title = dialog.querySelector('h2');
  const provider = dialog.querySelector('.voice-provider');
  const status = dialog.querySelector('.voice-status');
  const elapsed = dialog.querySelector('.voice-elapsed');
  const preview = dialog.querySelector('.voice-preview');
  const cancelButton = dialog.querySelector('.voice-cancel');
  const sendButton = dialog.querySelector('.voice-send');
  const insertButton = dialog.querySelector('.voice-insert');
  bindText(title, () => tr('voice.title'));
  bindText(cancelButton, () => tr('voice.cancel'));
  bindText(sendButton, () => tr('voice.send'));
  bindText(insertButton, () => tr('voice.insert'));

  function say(key) {
    bindText(status, () => tr(key));
  }
  function stopTracks(op) {
    for (const track of op?.stream?.getTracks() || []) track.stop();
    op.stream = null;
  }
  function stopClock(op) {
    if (op.clock) clearInterval(op.clock);
    op.clock = null;
  }
  function cancel() {
    const op = operation;
    operation = null;
    if (op) {
      op.abort.abort();
      stopClock(op);
      if (op.watchdog) clearInterval(op.watchdog);
      op.watchdog = null;
      stopTracks(op);
      if (op.recorder?.state !== 'inactive') {
        try {
          op.recorder.stop();
        } catch {}
      }
    }
    if (dialog.open) dialog.close();
  }
  function refresh() {
    for (const [button, entry] of buttons) {
      if (button.isConnected) entry.everConnected = true;
      else if (entry.everConnected) {
        buttons.delete(button);
        continue;
      }
      button.hidden = !config?.enabled;
      button.disabled = !config?.enabled || !canRecord(entry.origin);
    }
    if (
      operation &&
      (!canRecord(operation.origin) ||
        (['requesting', 'recording', 'ready'].includes(operation.phase) &&
          !bindingCurrent(operation.origin, operation.snapshot)))
    )
      cancel();
  }
  function mount(form, origin) {
    if (!form) return;
    const existing = form.querySelector('.voice-open');
    if (existing) {
      if (!buttons.has(existing)) buttons.set(existing, { origin, everConnected: existing.isConnected });
      return;
    }
    const toolbar = form.querySelector('.composer-toolbar');
    if (!toolbar) return;
    const button = document.createElement('button');
    button.className = 'voice-open';
    button.type = 'button';
    button.hidden = !config?.enabled;
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg>';
    bindAttribute(button, 'aria-label', () => tr('voice.open'));
    bindAttribute(button, 'title', () => tr('voice.open'));
    const send = form.querySelector('.send-button');
    if (send?.parentElement) send.parentElement.insertBefore(button, send);
    else toolbar.append(button);
    buttons.set(button, { origin, everConnected: button.isConnected });
    button.addEventListener('click', () => void start(buttons.get(button)?.origin));
    refresh();
  }
  function updateElapsed(op) {
    const ms = Math.min(Date.now() - op.started, config.maxDurationMs);
    const seconds = Math.floor(ms / 1000);
    elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (ms >= config.maxDurationMs && op.recorder?.state === 'recording') {
      finishRecording(op);
      say('voice.limitDuration');
    }
  }
  function finishRecording(op) {
    stopClock(op);
    if (op.recorder?.state === 'recording') {
      try {
        op.recorder.stop();
      } catch {}
    }
    stopTracks(op);
    if (op.phase === 'recording') op.phase = 'ready';
    sendButton.disabled = op.phase !== 'ready';
  }
  async function start(origin) {
    if (operation || !config?.enabled || !canRecord(origin)) return;
    const snapshot = capture(origin);
    if (!snapshot) return;
    const op = {
      origin,
      snapshot,
      abort: new AbortController(),
      chunks: [],
      totalBytes: 0,
      stream: null,
      recorder: null,
      clock: null,
      watchdog: null,
      started: 0,
      phase: 'requesting',
    };
    operation = op;
    op.watchdog = setInterval(() => {
      if (
        operation === op &&
        (!canRecord(origin) ||
          (['requesting', 'recording', 'ready'].includes(op.phase) && !bindingCurrent(origin, snapshot)))
      )
        cancel();
    }, 250);
    preview.hidden = true;
    insertButton.hidden = true;
    sendButton.disabled = true;
    elapsed.textContent = '0:00';
    bindText(provider, () => tr(config.provider === 'groq' ? 'voice.providerGroq' : 'voice.providerWhisper'));
    say('voice.requesting');
    dialog.showModal();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function')
        throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (operation !== op || !canRecord(origin) || !bindingCurrent(origin, snapshot)) {
        for (const track of stream.getTracks()) track.stop();
        if (operation === op) cancel();
        return;
      }
      op.stream = stream;
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('unsupported');
      op.recorder = new MediaRecorder(stream, { mimeType });
      op.stopped = new Promise((resolve) => op.recorder.addEventListener('stop', resolve, { once: true }));
      op.recorder.ondataavailable = (event) => {
        if (operation !== op || !event.data?.size) return;
        op.chunks.push(event.data);
        op.totalBytes += event.data.size;
        if (op.totalBytes > config.maxAudioBytes) {
          op.phase = 'error';
          finishRecording(op);
          sendButton.disabled = true;
          say('voice.limitSize');
        }
      };
      op.recorder.onerror = () => {
        if (operation === op) {
          op.phase = 'error';
          finishRecording(op);
          say('voice.recordFailed');
        }
      };
      op.recorder.start(500);
      op.phase = 'recording';
      op.started = Date.now();
      op.clock = setInterval(() => updateElapsed(op), 250);
      say('voice.recording');
      sendButton.disabled = false;
    } catch (error) {
      if (operation !== op) return;
      stopTracks(op);
      op.phase = 'error';
      sendButton.disabled = true;
      say(
        error?.name === 'NotAllowedError'
          ? 'voice.denied'
          : error?.message === 'unsupported'
            ? 'voice.unsupported'
            : 'voice.recordFailed',
      );
    }
  }
  async function send() {
    const op = operation;
    if (!op || !op.recorder || !['recording', 'ready'].includes(op.phase)) return;
    op.phase = 'transcribing';
    sendButton.disabled = true;
    say('voice.transcribing');
    const recorder = op.recorder;
    finishRecording(op);
    await op.stopped;
    if (operation !== op || op.phase !== 'transcribing') return;
    const audio = new Blob(op.chunks, { type: recorder.mimeType });
    if (!audio.size || audio.size > config.maxAudioBytes) {
      op.phase = 'error';
      say(audio.size ? 'voice.limitSize' : 'voice.empty');
      return;
    }
    try {
      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': audio.type },
        body: audio,
        signal: op.abort.signal,
      });
      const data = await response.json();
      if (operation !== op) return;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (typeof data?.text !== 'string') throw new Error('invalid transcript');
      const text = data.text.trim();
      if (!text) {
        op.phase = 'error';
        say('voice.empty');
        return;
      }
      if (text.length > 32000) {
        op.phase = 'error';
        say('voice.limitText');
        return;
      }
      op.transcript = text;
      if (!current(op.origin, op.snapshot)) {
        op.phase = 'conflict';
        preview.textContent = text;
        preview.hidden = false;
        insertButton.hidden = false;
        say('voice.changed');
        return;
      }
      if (!insert(op.origin, text, op.snapshot)) {
        say('voice.changed');
        return;
      }
      cancel();
      submit(op.origin);
    } catch (error) {
      if (operation !== op) return;
      op.phase = 'error';
      say(error?.name === 'AbortError' ? 'voice.cancelled' : 'voice.transcribeFailed');
    }
  }
  cancelButton.addEventListener('click', cancel);
  sendButton.addEventListener('click', () => void send());
  insertButton.addEventListener('click', () => {
    const op = operation;
    if (!op?.transcript) return;
    if (insert(op.origin, op.transcript, op.snapshot)) cancel();
    else say('voice.insertUnavailable');
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  dialog.addEventListener('close', () => {
    if (operation) cancel();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancel();
  });
  window.addEventListener('pagehide', cancel);
  void fetch('/api/voice')
    .then(async (response) => {
      if (response.ok) config = await response.json();
      refresh();
    })
    .catch(() => refresh());
  return { mount, refresh, cancel };
}
