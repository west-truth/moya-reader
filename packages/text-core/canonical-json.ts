function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('Canonical JSON does not support bigint values.');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toJSON();
  if (value instanceof Uint8Array) return [...value];
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Canonical JSON does not support cyclic values.');

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalValue(item, seen) ?? null);
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = canonicalValue((value as Record<string, unknown>)[key], seen);
      if (item !== undefined) result[key] = item;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Stable JSON for identity and integrity contracts shared by browser and Node runtimes. */
export function canonicalJson(value: unknown): string {
  const normalized = canonicalValue(value, new Set());
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) throw new TypeError('Canonical JSON requires a JSON-compatible root value.');
  return encoded;
}
