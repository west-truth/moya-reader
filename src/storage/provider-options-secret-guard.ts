const secretKeyPattern =
  /(api.?key|secret|token|credential|password|private.?key|authorization|bearer|client.?secret|access.?key|refresh.?token|endpoint.?url)/i;
const secretValuePattern =
  /(^sk-(?:proj-)?[A-Za-z0-9_-]{8,}|^AIza[A-Za-z0-9_-]{10,}|^ya29\.|Bearer\s+[A-Za-z0-9._~+/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|"client_email"\s*:)/i;

export function providerOptionsContainSecretLikeValue(value: unknown): boolean {
  if (typeof value === 'string') return secretValuePattern.test(value.trim());
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(providerOptionsContainSecretLikeValue);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => secretKeyPattern.test(key) || providerOptionsContainSecretLikeValue(child),
  );
}
