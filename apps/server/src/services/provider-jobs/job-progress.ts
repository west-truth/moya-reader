export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringArrayValue(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return stringArrayValue(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function providerOptionsFromJobProgress(progress: unknown): Record<string, unknown> {
  return recordValue(recordValue(progress)?.providerOptions) ?? {};
}

export function booleanProviderOption(options: Record<string, unknown>, key: string): boolean {
  const value = options[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return false;
}
