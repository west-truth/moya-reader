/** Host-rendered authentication. Credentials never become SDK return values or source storage. */
export interface SourceAuthentication {
  readonly sourceId: string;
  readonly label: string;
  readonly origin: string;
  readonly scheme: 'bearer' | 'cookie' | 'basic';
  readonly cookieName?: string;
  readonly verification: {
    readonly path: string;
    readonly field: readonly string[];
    readonly equals: string | boolean | number;
  };
}

export type SourceAuthenticationInput = { readonly secret: string; readonly username?: string };
export type SourceAuthenticationRequest =
  | { readonly action: 'status' | 'check' | 'remove' }
  | { readonly action: 'save'; readonly credential: SourceAuthenticationInput };
export interface SourceAuthenticationStatus {
  readonly state: 'missing' | 'saved' | 'valid' | 'invalid' | 'forbidden' | 'error';
  readonly checkedAt?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const controls = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function validateSourceAuthentication(
  value: unknown,
  sources: readonly string[],
  origins: readonly string[],
): boolean {
  if (!Array.isArray(value) || value.length > 16) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    if (
      !object(item) ||
      !keys(item, ['sourceId', 'label', 'origin', 'scheme', 'cookieName', 'verification']) ||
      typeof item.sourceId !== 'string' ||
      !sources.includes(item.sourceId) ||
      seen.has(item.sourceId) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 80 ||
      controls(item.label) ||
      typeof item.origin !== 'string' ||
      !origins.includes(item.origin) ||
      !['bearer', 'cookie', 'basic'].includes(String(item.scheme))
    )
      return false;
    seen.add(item.sourceId);
    if (
      item.scheme === 'cookie'
        ? typeof item.cookieName !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.cookieName)
        : item.cookieName !== undefined
    )
      return false;
    const probe = item.verification;
    if (
      !object(probe) ||
      !keys(probe, ['path', 'field', 'equals']) ||
      typeof probe.path !== 'string' ||
      !probe.path.startsWith('/') ||
      probe.path.startsWith('//') ||
      probe.path.length > 1024 ||
      /[\\# ]/.test(probe.path) ||
      controls(probe.path)
    )
      return false;
    if (
      new URL(probe.path, item.origin).origin !== item.origin ||
      !Array.isArray(probe.field) ||
      !probe.field.length ||
      probe.field.length > 8 ||
      probe.field.some(
        (key) =>
          typeof key !== 'string' ||
          !/^[A-Za-z0-9_-]{1,80}$/.test(key) ||
          ['__proto__', 'constructor', 'prototype'].includes(key),
      )
    )
      return false;
    return (
      typeof probe.equals === 'boolean' ||
      (typeof probe.equals === 'number' && Number.isFinite(probe.equals)) ||
      (typeof probe.equals === 'string' && probe.equals.length > 0 && probe.equals.length <= 128)
    );
  });
}

export function validateSourceAuthenticationRequest(value: unknown): value is SourceAuthenticationRequest {
  if (!object(value) || !keys(value, ['action', 'credential'])) return false;
  if (['status', 'check', 'remove'].includes(String(value.action))) return value.credential === undefined;
  const credential = value.credential;
  return (
    value.action === 'save' &&
    object(credential) &&
    keys(credential, ['secret', 'username']) &&
    typeof credential.secret === 'string' &&
    credential.secret.length > 0 &&
    credential.secret.length <= 8192 &&
    !controls(credential.secret) &&
    (credential.username === undefined ||
      (typeof credential.username === 'string' &&
        credential.username.length > 0 &&
        credential.username.length <= 256 &&
        !credential.username.includes(':') &&
        !controls(credential.username)))
  );
}
