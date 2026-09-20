export function joinTask<T>(
  pending: Map<string, unknown>,
  key: string,
  signal: AbortSignal,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T>;
