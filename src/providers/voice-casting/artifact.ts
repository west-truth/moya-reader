import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';

export function voiceCastingIdentity(
  namespace: string,
  core: unknown,
): {
  readonly id: string;
  readonly revision: string;
  readonly fingerprint: string;
} {
  const fingerprint = structuredIntegrityHash(core);
  return {
    id: persistentId128(namespace, [fingerprint]),
    revision: persistentId128(`${namespace}_revision`, [fingerprint]),
    fingerprint,
  };
}

export function assertNarrativeInterval(input: {
  readonly effectiveFromOrder: number;
  readonly effectiveToOrder?: number;
}): void {
  if (!Number.isSafeInteger(input.effectiveFromOrder) || input.effectiveFromOrder < 0) {
    throw new Error('effectiveFromOrder must be a nonnegative safe integer');
  }
  if (
    input.effectiveToOrder !== undefined &&
    (!Number.isSafeInteger(input.effectiveToOrder) || input.effectiveToOrder < input.effectiveFromOrder)
  ) {
    throw new Error('effectiveToOrder must be a safe integer at or after effectiveFromOrder');
  }
}

export function includesNarrativeOrder(
  interval: { readonly effectiveFromOrder: number; readonly effectiveToOrder?: number },
  narrativeOrder: number,
): boolean {
  return (
    narrativeOrder >= interval.effectiveFromOrder &&
    (interval.effectiveToOrder === undefined || narrativeOrder <= interval.effectiveToOrder)
  );
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
