// Server receipts are authoritative across devices. Inspect changed, idle histories only: file
// timestamps also change for renames/settings and are not completion signals.
const active = (run) => ['running', 'stopping'].includes(run.status);
const stamp = (session) => `${session.updatedAt || ''}:${session.messageCount ?? 0}`;

export function lastAnswer(messages = []) {
  const conversation = messages.filter((message) => ['user', 'assistant'].includes(message.role));
  const index = conversation.findLastIndex(
    (message) =>
      message.role === 'assistant' &&
      !message.error &&
      !message.tools?.length &&
      (!message.stopReason || ['stop', 'length'].includes(message.stopReason)) &&
      Boolean(message.text?.trim() || message.thinking?.trim()),
  );
  const message = conversation[index];
  return message ? { id: message.id || `${message.timestamp}:${index}`, index } : null;
}

export function createSessionActivity({
  read,
  write,
  loadHistory,
  saveRead,
  saveUnread,
  onChange = () => {},
}) {
  const pending = new Map();
  const reading = new Map();
  const key = (id) => `session-activity.${id}`;
  const entry = (id) => {
    const value = read(key(id), null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  };
  function observeShared(session) {
    const remote = session.readState;
    if (!remote) return false;
    const previous = entry(session.id);
    // History snapshots and receipts can arrive out of order independently.
    // A receipt acknowledgement has no history metadata and must not replace a newer answer.
    const current = {
      ...previous,
      ...(!previous ||
      (session.updatedAt && !(Date.parse(previous.updatedAt) > Date.parse(session.updatedAt)))
        ? {
            stamp: session.messages ? stamp(session) : previous?.stamp,
            updatedAt: session.updatedAt,
            answer: remote.answer,
          }
        : {}),
      ...((previous?.revision || 0) <= remote.revision
        ? { read: remote.read, revision: remote.revision }
        : {}),
    };
    current.unread = Boolean(
      current.answer && current.answer !== current.read && reading.get(session.id)?.answer !== current.answer,
    );
    write(key(session.id), current);
    return true;
  }

  function initialize(sessions) {
    for (const session of sessions) observeShared(session);
    if (read('session-activity.initialized', false)) return;
    // Existing conversations are the starting point, not a backlog of alerts.
    for (const session of sessions)
      if (!entry(session.id))
        write(key(session.id), { stamp: stamp(session), count: session.messageCount || 0, unread: false });
    write('session-activity.initialized', true);
  }

  function observe(history) {
    if (observeShared(history)) return;
    const previous = entry(history.id) || { answer: '', count: 0, unread: false };
    // Another tab may already have inspected/read a more recent snapshot.
    if (Date.parse(previous.updatedAt) > Date.parse(history.updatedAt)) return;
    const answer = lastAnswer(history.messages);
    const changed =
      answer &&
      (previous.answer === undefined ? answer.index >= previous.count : answer.id !== previous.answer);
    write(key(history.id), {
      stamp: stamp(history),
      updatedAt: history.updatedAt,
      count: history.messageCount || 0,
      answer: answer?.id || '',
      unread: Boolean(answer && (previous.unread || changed)),
    });
  }

  function markRead(id, messages, observedAnswer = null) {
    const previous = entry(id);
    // A paged tail may contain only recent tool steps. Its fetched snapshot has
    // the authoritative final-answer receipt; a newer overview alone must not ack it.
    const answer = observedAnswer || lastAnswer(messages)?.id;
    if (!previous?.unread || previous.answer !== answer) return false;
    if (saveRead && previous.revision) {
      if (reading.has(id)) return false;
      const guard = { answer: previous.answer, pending: null };
      reading.set(id, guard);
      write(key(id), { ...previous, unread: false });
      guard.pending = Promise.resolve()
        .then(() => saveRead(id, previous.answer))
        .then((result) => {
          if (reading.get(id) === guard) reading.delete(id);
          // Keep the stamp: a receipt response need not contain history metadata.
          observeShared({ id, readState: result.readState });
          onChange();
        })
        .catch(() => {
          if (reading.get(id) === guard) reading.delete(id);
          const current = entry(id);
          if (current)
            write(key(id), {
              ...current,
              unread: Boolean(current.answer && current.answer !== current.read),
            });
          onChange();
        });
      return true;
    }
    write(key(id), { ...previous, unread: false });
    return true;
  }

  async function markUnread(id) {
    const inFlight = reading.get(id)?.pending;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* markRead already reconciled local state; fall through to explicit unread. */
      }
    }
    if (saveUnread) {
      const result = await saveUnread(id);
      observeShared({ id, readState: result.readState });
      onChange();
      return true;
    }
    const previous = entry(id);
    if (!previous?.answer) return false;
    write(key(id), { ...previous, unread: true });
    onChange();
    return true;
  }

  async function sync(sessions, runs, { activeSessionId = null } = {}) {
    for (const session of sessions) observeShared(session);
    const running = new Set(runs.filter(active).map((run) => run.sessionId));
    const queue = sessions.filter(
      (session) =>
        !running.has(session.id) &&
        // Shared receipts already describe unopened sessions. Only the active
        // history needs a refresh; old servers without receipts keep the fallback.
        (!session.readState || session.id === activeSessionId) &&
        entry(session.id)?.stamp !== stamp(session),
    );
    const histories = [];
    // Keep startup/navigation responsive even with a large session archive.
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
          const session = queue.shift();
          let request = pending.get(session.id);
          if (!request) {
            request = loadHistory(session.id)
              .then((history) => {
                observe(history);
                return history;
              })
              .finally(() => pending.delete(session.id));
            pending.set(session.id, request);
          }
          try {
            histories.push(await request);
          } catch {
            /* Retry on the next overview. */
          }
        }
      }),
    );
    return histories;
  }

  return { initialize, observe, markRead, markUnread, sync, isUnread: (id) => entry(id)?.unread === true };
}
