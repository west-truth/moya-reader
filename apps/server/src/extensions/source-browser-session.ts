import type { BrowserContext } from 'playwright-core';
import type { SourceWebViewScope } from './source-webview.js';
type Storage = Awaited<ReturnType<BrowserContext['storageState']>>;
export type SourceBrowserSession = Storage & { userAgents?: Record<string, string> };
export function readBrowserSession(scope: SourceWebViewScope): SourceBrowserSession {
  const raw = scope.vault?.read(scope.key)?.secret;
  return raw ? JSON.parse(raw) : { cookies: [], origins: [] };
}
export function writeBrowserSession(scope: SourceWebViewScope, state: SourceBrowserSession) {
  const secret = JSON.stringify(state);
  if (Buffer.byteLength(secret) > 1024 * 1024) throw new Error('source_body_limit');
  scope.vault?.write(scope.key, { secret });
}
/** Apply only browser changes; parallel HTTP requests may have updated other cookies meanwhile. */
export function mergeBrowserSession(
  scope: SourceWebViewScope,
  before: SourceBrowserSession,
  after: Storage,
  userAgents: Record<string, string>,
) {
  const latest = readBrowserSession(scope);
  const merge = <T>(old: T[], next: T[], current: T[], key: (row: T) => string) => {
    const previous = new Map(old.map((row) => [key(row), row]));
    const updated = new Map(next.map((row) => [key(row), row]));
    const result = new Map(current.map((row) => [key(row), row]));
    for (const id of new Set([...previous.keys(), ...updated.keys()])) {
      if (JSON.stringify(previous.get(id)) === JSON.stringify(updated.get(id))) continue;
      if (updated.has(id)) result.set(id, updated.get(id)!);
      else result.delete(id);
    }
    return [...result.values()];
  };
  writeBrowserSession(scope, {
    cookies: merge(before.cookies, after.cookies, latest.cookies, (c) => JSON.stringify([c.name, c.domain, c.path])),
    origins: merge(before.origins, after.origins, latest.origins, (o) => o.origin),
    userAgents: { ...latest.userAgents, ...userAgents },
  });
}
