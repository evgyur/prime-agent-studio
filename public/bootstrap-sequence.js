// Bootstrap sequencing guard: the newest run wins, one retry timer at a
// time. Pure on purpose so stale-discard and single-timer semantics are
// unit-tested in node without a browser (see test/bootstrap-guard.test.mjs).
export function createBootstrapGuard() {
  let current = 0;
  let timer = null;
  const guard = {
    start() {
      current += 1;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return current;
    },
    isCurrent(id) {
      return id === current;
    },
    schedule(id, ms, fn) {
      if (!guard.isCurrent(id) || timer) return false;
      timer = setTimeout(() => {
        timer = null;
        if (guard.isCurrent(id)) fn();
      }, ms);
      return true;
    },
    get pending() {
      return timer !== null;
    },
  };
  return guard;
}
