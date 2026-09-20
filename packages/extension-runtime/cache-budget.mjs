/** A shared payload budget; owner quotas never allow one account to consume the whole pool. */
export class CacheBudget {
  #entries = new Map();
  #bytes = 0;
  constructor(maxBytes, maxEntries, ownerBytes = maxBytes, ownerEntries = maxEntries) {
    Object.assign(this, { maxBytes, maxEntries, ownerBytes, ownerEntries });
  }
  get(owner, key) {
    for (const [id, entry] of this.#entries) {
      if (entry.owner !== owner || entry.key !== key) continue;
      if (entry.expires <= Date.now()) {
        this.#remove(id);
        return undefined;
      }
      this.#entries.delete(id);
      this.#entries.set(id, entry);
      return entry.value;
    }
  }
  #remove(id) {
    const entry = this.#entries.get(id);
    if (entry) this.#bytes -= entry.bytes;
    this.#entries.delete(id);
  }
  set(owner, key, value, bytes, expires) {
    this.delete(owner, key);
    if (bytes > this.ownerBytes || bytes > this.maxBytes || expires <= Date.now()) return;
    for (const [id, entry] of this.#entries) if (entry.expires <= Date.now()) this.#remove(id);
    let owned = [...this.#entries.values()].filter((entry) => entry.owner === owner);
    let ownedBytes = owned.reduce((total, entry) => total + entry.bytes, 0);
    for (const [id, entry] of this.#entries) {
      if (owned.length < this.ownerEntries && ownedBytes + bytes <= this.ownerBytes) break;
      if (entry.owner !== owner) continue;
      this.#remove(id);
      ownedBytes -= entry.bytes;
      owned = owned.slice(1);
    }
    while (this.#entries.size && (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes)) {
      this.#remove(this.#entries.keys().next().value);
    }
    this.#entries.set(Symbol(), { owner, key, value, bytes, expires });
    this.#bytes += bytes;
  }
  keys(owner) {
    return [...this.#entries.values()].filter((entry) => entry.owner === owner).map((entry) => entry.key);
  }
  delete(owner, key) {
    for (const [id, entry] of this.#entries) if (entry.owner === owner && entry.key === key) this.#remove(id);
  }
  clear(owner) {
    for (const [id, entry] of this.#entries) if (entry.owner === owner) this.#remove(id);
  }
}
