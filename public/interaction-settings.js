import { t, bindText, getLanguage, onLanguageChange } from './i18n.js';

// Module-shared confirmed allowQuestionsByDefault (global studio pref): a
// confirmed PATCH/refresh in one instance fans out to siblings synchronously
// so sendMessage defaults stay fresh. Siblings adopt only when no own save is
// in flight, preserving dirty drafts.
let sharedAllowQuestions = null;
let sharedAllowQuestionsRevision = -1;
const sharedAllowQuestionsListeners = new Set();
function revisionNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function publishAllowQuestions(value, revision) {
  if (typeof value !== 'boolean') return false;
  const rev = revisionNumber(revision);
  // Server revision ordering (same class as computer prefs): a delayed GET or
  // a stale PATCH ack with an older revision must never roll back a newer
  // confirmed value. Reads without a revision keep the legacy merge path.
  if (rev !== undefined) {
    if (rev < sharedAllowQuestionsRevision) return false;
    if (rev > sharedAllowQuestionsRevision) sharedAllowQuestionsRevision = rev;
  }
  sharedAllowQuestions = value;
  for (const fn of [...sharedAllowQuestionsListeners]) {
    try {
      fn(value);
    } catch {}
  }
  return true;
}
export function __resetSharedAllowQuestionsForTests() {
  sharedAllowQuestions = null;
  sharedAllowQuestionsRevision = -1;
}

export function createInteractionSettings({
  api,
  getContext,
  onStudioPreferences,
  getElement = null,
  domId = null,
  instanceId = '',
  isPrimary = true,
} = {}) {
  void domId;
  void instanceId;
  void isPrimary;
  const $ = (id) => (typeof getElement === 'function' ? getElement(id) : document.getElementById(id));
  const core = window.__PRIME_STUDIO_NOTIFICATIONS__ === true && window.__TAURI__?.core;
  let defaultBusy = false,
    notificationsBusy = false,
    preferences;
  const error = (id, failed) => {
    $(id).hidden = !failed;
    bindText($(id), () => (failed ? t('interactionSettings.saveError') : ''));
  };
  function onSharedAllowQuestions(value) {
    if (defaultBusy || typeof value !== 'boolean') return;
    try {
      $('default-allow-questions').checked = value;
    } catch {}
  }
  sharedAllowQuestionsListeners.add(onSharedAllowQuestions);
  if (sharedAllowQuestions !== null) onSharedAllowQuestions(sharedAllowQuestions);
  async function refreshDefault() {
    if (defaultBusy) return;
    defaultBusy = true;
    $('default-allow-questions').disabled = true;
    try {
      const result = await api('/api/studio-preferences');
      const incomingRev = revisionNumber(result?.revision);
      // Late GET safety: a stale read (older revision than the shared
      // confirmed snapshot) adopts the shared value instead of rolling back
      // this checkbox, and never notifies the parent with old data.
      if (
        incomingRev !== undefined &&
        incomingRev < sharedAllowQuestionsRevision &&
        sharedAllowQuestions !== null
      ) {
        try {
          $('default-allow-questions').checked = sharedAllowQuestions;
        } catch {}
        error('default-questions-error', false);
      } else {
        $('default-allow-questions').checked = result.allowQuestionsByDefault;
        publishAllowQuestions(result.allowQuestionsByDefault, incomingRev);
        onStudioPreferences(result);
        error('default-questions-error', false);
      }
    } catch {
      error('default-questions-error', true);
    } finally {
      defaultBusy = false;
      $('default-allow-questions').disabled = getContext().readOnly;
    }
  }
  $('default-allow-questions').onchange = async () => {
    if (defaultBusy || getContext().readOnly) return;
    defaultBusy = true;
    const control = $('default-allow-questions'),
      value = control.checked;
    control.disabled = true;
    try {
      const result = await api('/api/studio-preferences', {
        method: 'PATCH',
        body: { allowQuestionsByDefault: value },
      });
      const ackRev = revisionNumber(result?.revision);
      // Stale PATCH ack (older revision than the shared confirmed snapshot,
      // e.g. out-of-order completions): restore the shared value, never
      // publish and never notify the parent with old data.
      if (ackRev !== undefined && ackRev < sharedAllowQuestionsRevision && sharedAllowQuestions !== null) {
        control.checked = sharedAllowQuestions;
        error('default-questions-error', false);
      } else {
        onStudioPreferences(result);
        control.checked = result.allowQuestionsByDefault;
        publishAllowQuestions(result.allowQuestionsByDefault, ackRev);
        error('default-questions-error', false);
      }
    } catch {
      control.checked = !value;
      error('default-questions-error', true);
    } finally {
      defaultBusy = false;
      control.disabled = getContext().readOnly;
    }
  };
  const native = () => !!core && !getContext().remote;
  function renderNotifications() {
    for (const [id, key] of [
      ['notify-questions', 'questions'],
      ['notify-turn-complete', 'turnComplete'],
    ]) {
      $(id).checked = preferences?.[key] !== false;
      $(id).disabled = notificationsBusy || !preferences;
    }
  }
  async function refreshNotifications() {
    $('notification-options').hidden = !native();
    $('notifications-desktop-note').hidden = native();
    if (!native() || notificationsBusy) return;
    notificationsBusy = true;
    renderNotifications();
    try {
      preferences = await core.invoke('desktop_notification_preferences');
      error('notifications-error', false);
    } catch {
      error('notifications-error', true);
    } finally {
      notificationsBusy = false;
      renderNotifications();
    }
  }
  for (const [id, key] of [
    ['notify-questions', 'questions'],
    ['notify-turn-complete', 'turnComplete'],
  ]) {
    $(id).onchange = async () => {
      if (!native() || notificationsBusy) return;
      notificationsBusy = true;
      const value = $(id).checked,
        previous = preferences;
      preferences = { ...preferences, [key]: value };
      renderNotifications();
      try {
        preferences = await core.invoke('desktop_notification_preferences', { patch: { [key]: value } });
        error('notifications-error', false);
      } catch {
        preferences = previous;
        error('notifications-error', true);
      } finally {
        notificationsBusy = false;
        renderNotifications();
      }
    };
  }
  const syncLanguage = () => {
    if (native())
      void core
        .invoke('desktop_notification_preferences', {
          patch: { language: getLanguage() },
        })
        .catch(() => {});
  };
  const offLanguage = onLanguageChange(syncLanguage);
  syncLanguage();
  const root = () =>
    typeof getElement === 'function'
      ? getElement('settings-dialog')
      : document.getElementById('settings-dialog');
  return {
    refreshDefault,
    refreshNotifications,
    get root() {
      return root();
    },
    dispose: () => {
      try {
        sharedAllowQuestionsListeners.delete(onSharedAllowQuestions);
      } catch {}
      try {
        offLanguage?.();
      } catch {}
    },
  };
}
