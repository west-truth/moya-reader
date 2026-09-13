/** Share a cache fill without allowing one reader's cancellation to cancel other readers. */
export function joinTask(pending, key, signal, task) {
  signal.throwIfAborted();
  let entry = pending.get(key);
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    entry = { controller, users: 0, promise: Promise.resolve().then(() => task(controller.signal)) };
    pending.set(key, entry);
    const active = entry;
    void entry.promise
      .finally(() => {
        if (pending.get(key) === active) pending.delete(key);
      })
      .catch(() => {});
  }
  entry.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      if (--entry.users === 0) entry.controller.abort();
      callback(value);
    };
    const cancel = () => finish(reject, signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    entry.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}
