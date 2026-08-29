import type { ExtensionContributionId } from '@noveldesk/extension-contracts';

export interface TrustedWorkflowRunnerRegistration<TRunner> {
  readonly workflowId: ExtensionContributionId;
  readonly workflowVersion: string;
  create(baseRunner: TRunner): TRunner;
}

/** Source-reviewed execution factories. This registry is never populated from a community manifest. */
export class TrustedWorkflowRunnerRegistry<TRunner> {
  private readonly registrations = new Map<ExtensionContributionId, TrustedWorkflowRunnerRegistration<TRunner>>();

  register(registration: TrustedWorkflowRunnerRegistration<TRunner>): void {
    if (this.registrations.has(registration.workflowId)) {
      throw new Error(`Duplicate trusted workflow runner: ${registration.workflowId}`);
    }
    this.registrations.set(registration.workflowId, registration);
  }

  has(workflowId: ExtensionContributionId): boolean {
    return this.registrations.has(workflowId);
  }

  resolve(workflowId: ExtensionContributionId, baseRunner: TRunner): TRunner {
    const registration = this.registrations.get(workflowId);
    if (!registration) throw new Error(`Trusted workflow runner is unavailable: ${workflowId}`);
    return registration.create(baseRunner);
  }

  listWorkflowIds(): readonly ExtensionContributionId[] {
    return [...this.registrations.keys()].sort((left, right) => left.localeCompare(right));
  }
}
