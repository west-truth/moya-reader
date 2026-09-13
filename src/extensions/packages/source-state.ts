import type { SourceJsonValue } from '@noveldesk/extension-contracts/source-sdk';
import type { InstalledPackageRecord } from './package-install-store';

export type SourceStateValues = Readonly<Record<string, SourceJsonValue>>;
export interface SourceStateChanges {
  readonly readKeys: readonly string[];
  readonly writes: readonly { key: string; value?: SourceJsonValue }[];
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function key(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(value) ||
    ['__proto__', 'prototype', 'constructor'].includes(value)
  )
    throw new Error('invalid_source_storage');
}
function portableString(value: string): boolean {
  // PostgreSQL JSONB rejects NUL and unpaired UTF-16 surrogates; use the same contract on devices.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}
function json(value: unknown, depth = 0): value is SourceJsonValue {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return portableString(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every((item) => json(item, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(([name, item]) => portableString(name) && json(item, depth + 1));
}
function clone(value: SourceJsonValue): SourceJsonValue {
  return JSON.parse(JSON.stringify(value));
}

export function sourceStateScope(
  record: InstalledPackageRecord | undefined,
  revision: number,
  sourceId: string,
): number {
  if (
    !record?.active ||
    !record.enabled ||
    record.revision !== revision ||
    !record.active.manifest.extension.contributes?.externalSources?.some((source) => source.id === sourceId)
  )
    throw new Error('package_generation_changed');
  return record.active.manifest.requestedAccess.storageKiB;
}
export function sourceStateView(all: SourceStateValues, sourceId: string): SourceStateValues {
  const prefix = `${sourceId}/`;
  return Object.fromEntries(
    Object.entries(all)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => [name.slice(prefix.length), clone(value)]),
  );
}

/** Merge only this source's touched keys. Independent downloads may commit disjoint keys without lost updates. */
export function mergeSourceState(
  all: SourceStateValues,
  sourceId: string,
  base: SourceStateValues,
  changes: SourceStateChanges,
  quotaKiB: number,
): SourceStateValues {
  if (!quotaKiB) throw new Error('permission_denied');
  if (
    !changes ||
    !Array.isArray(changes.readKeys) ||
    !Array.isArray(changes.writes) ||
    changes.readKeys.length > 64 ||
    changes.writes.length > 64
  )
    throw new Error('invalid_source_storage');
  const reads = new Set(changes.readKeys);
  const written = new Set<string>();
  for (const name of reads) {
    key(name);
    const qualified = `${sourceId}/${name}`;
    if (
      own(all, qualified) !== own(base, name) ||
      (own(base, name) && JSON.stringify(all[qualified]) !== JSON.stringify(base[name]))
    )
      throw new Error('source_storage_conflict');
  }
  const next = { ...all };
  for (const write of changes.writes) {
    key(write?.key);
    if (!reads.has(write.key) || written.has(write.key)) throw new Error('invalid_source_storage');
    written.add(write.key);
    const qualified = `${sourceId}/${write.key}`;
    if (!own(write, 'value')) delete next[qualified];
    else {
      if (!json(write.value) || bytes(write.value) > 64 * 1024) throw new Error('source_storage_limit');
      next[qualified] = clone(write.value);
    }
  }
  // A quota decrease must still allow the source to shrink/delete old data over several invocations.
  if (Object.keys(next).length > 1024 || (bytes(next) > quotaKiB * 1024 && bytes(next) >= bytes(all)))
    throw new Error('source_storage_limit');
  return next;
}

/** Host-owned staged storage. A failed/invalid/cancelled invocation never commits guest writes. No secrets. */
export function createSourceStateSession(snapshot: SourceStateValues = {}, quotaKiB = 0) {
  if (
    !Number.isInteger(quotaKiB) ||
    quotaKiB < 0 ||
    quotaKiB > 1024 ||
    typeof snapshot !== 'object' ||
    !json(snapshot) ||
    Array.isArray(snapshot) ||
    !snapshot ||
    bytes(snapshot) > 1024 * 1024
  )
    throw new Error('invalid_source_storage');
  const current: Record<string, SourceJsonValue> = Object.fromEntries(
    Object.entries(snapshot).map(([name, value]) => {
      key(name);
      return [name, clone(value)];
    }),
  );
  const readKeys = new Set<string>();
  const writes = new Map<string, { key: string; value?: SourceJsonValue }>();
  const validate = (input: unknown, signal: AbortSignal): Record<string, unknown> & { key: string } => {
    signal.throwIfAborted();
    if (!quotaKiB) throw new Error('permission_denied');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_source_storage');
    const value = input as Record<string, unknown>;
    key(value.key);
    readKeys.add(value.key);
    if (readKeys.size > 64) throw new Error('source_storage_limit');
    return value as Record<string, unknown> & { key: string };
  };
  return {
    methods: {
      'storage.get': async (input: unknown, signal: AbortSignal) => {
        const { key: name } = validate(input, signal);
        return own(current, name) ? clone(current[name]) : null;
      },
      'storage.set': async (input: unknown, signal: AbortSignal) => {
        const { key: name, value } = validate(input, signal);
        if (!json(value) || bytes(value) > 64 * 1024) throw new Error('source_storage_limit');
        const next = { ...current, [name]: value };
        if (bytes(next) > quotaKiB * 1024 && bytes(next) >= bytes(current)) throw new Error('source_storage_limit');
        current[name] = clone(value);
        writes.set(name, { key: name, value: clone(value) });
        return null;
      },
      'storage.remove': async (input: unknown, signal: AbortSignal) => {
        const { key: name } = validate(input, signal);
        delete current[name];
        writes.set(name, { key: name });
        return null;
      },
    },
    changes(): SourceStateChanges {
      return { readKeys: [...readKeys], writes: [...writes.values()] };
    },
  };
}
