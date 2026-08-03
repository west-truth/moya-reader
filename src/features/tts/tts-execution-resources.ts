export function releasePrefetchController(
  controllers: Map<string, AbortController>,
  requestKey: string,
  controller: AbortController,
): boolean {
  if (controllers.get(requestKey) !== controller) return false;
  controllers.delete(requestKey);
  return true;
}

export function abortPrefetchControllers(controllers: Map<string, AbortController>): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
}
