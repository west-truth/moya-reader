export interface ConnectedProviderPreflightInput {
  readonly syncBeforeJob?: () => Promise<boolean>;
  readonly targetStillActive?: () => boolean;
  readonly ensureAttached: () => Promise<boolean>;
}

export async function runConnectedProviderPreflight(
  input: ConnectedProviderPreflightInput,
): Promise<boolean> {
  if (input.syncBeforeJob && !(await input.syncBeforeJob())) return false;
  if (input.targetStillActive && !input.targetStillActive()) return false;
  return input.ensureAttached();
}
