export class CacheBudget<T> {
  constructor(maxBytes: number, maxEntries: number, ownerBytes?: number, ownerEntries?: number);
  get(owner: symbol, key: string): T | undefined;
  set(owner: symbol, key: string, value: T, bytes: number, expires: number): void;
  keys(owner: symbol): string[];
  delete(owner: symbol, key: string): void;
  clear(owner: symbol): void;
}
