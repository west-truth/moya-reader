/** Bound image traffic per catalog. One slot is reserved for reading; queued reads precede saves. */
export class ImageRequestQueue {
  #pending = [];
  #active = 0;
  #background = 0;
  promote(key) {
    const entry = this.#pending.find((entry) => entry.key === key);
    if (entry) entry.foreground = true;
    this.#drain();
  }
  run(key, foreground, signal, load) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { key, foreground, signal, load, resolve, reject, cancel: undefined };
      entry.cancel = () => {
        const index = this.#pending.indexOf(entry);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.#pending.push(entry);
      this.#drain();
    });
  }
  #drain() {
    while (this.#active < 3) {
      let index = this.#pending.findIndex((entry) => entry.foreground);
      if (index < 0 && this.#background < 2) index = this.#pending.length ? 0 : -1;
      if (index < 0) return;
      const [entry] = this.#pending.splice(index, 1);
      entry.signal.removeEventListener('abort', entry.cancel);
      if (entry.signal.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      const background = !entry.foreground;
      this.#active++;
      if (background) this.#background++;
      void Promise.resolve()
        .then(() => {
          entry.signal.throwIfAborted();
          return entry.load();
        })
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.#active--;
          if (background) this.#background--;
          this.#drain();
        });
    }
  }
}
