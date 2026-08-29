export const SELF_HOST_AUTH_REQUIRED_EVENT = 'moya:self-host-auth-required';

export function notifySelfHostAuthRequired(): void {
  globalThis.dispatchEvent?.(new Event(SELF_HOST_AUTH_REQUIRED_EVENT));
}
