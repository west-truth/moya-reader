import type {
  ResolvedSyncContract,
  SyncCapabilities,
  SyncContractFields,
  SyncContractVersion,
  SyncEvent,
} from './types';

export const SYNC_CONTRACT_V1: ResolvedSyncContract = {
  contractVersion: 1,
  idContract: 'v1-legacy',
  hashContract: 'v1-legacy',
};

export const SYNC_CONTRACT_V2: ResolvedSyncContract = {
  contractVersion: 2,
  idContract: 'v2-sha256-128',
  hashContract: 'v2-sha256-tagged',
};

export const CURRENT_SYNC_CAPABILITIES: SyncCapabilities = {
  ...SYNC_CONTRACT_V2,
  supportedContracts: [SYNC_CONTRACT_V1, SYNC_CONTRACT_V2],
  defaultPullContract: SYNC_CONTRACT_V2,
};

export class SyncContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncContractError';
  }
}

function contractForVersion(version: SyncContractVersion): ResolvedSyncContract {
  return version === 2 ? SYNC_CONTRACT_V2 : SYNC_CONTRACT_V1;
}

export function resolveSyncContract(value: SyncContractFields | undefined): ResolvedSyncContract {
  const version = value?.contractVersion;
  const idContract = value?.idContract;
  const hashContract = value?.hashContract;
  if (version === undefined && idContract === undefined && hashContract === undefined) return SYNC_CONTRACT_V1;
  if (version !== 1 && version !== 2) {
    throw new SyncContractError('unsupported_contract_version', 'Unsupported sync contractVersion.');
  }
  const expected = contractForVersion(version);
  if (idContract !== expected.idContract || hashContract !== expected.hashContract) {
    throw new SyncContractError(
      'inconsistent_contract_tuple',
      'contractVersion, idContract, and hashContract must identify the same sync contract.',
    );
  }
  return expected;
}

export function parseSyncContractFields(value: {
  contractVersion?: unknown;
  idContract?: unknown;
  hashContract?: unknown;
}): ResolvedSyncContract {
  const rawVersion = value.contractVersion;
  const contractVersion =
    rawVersion === undefined || rawVersion === ''
      ? undefined
      : rawVersion === 1 || rawVersion === '1'
        ? 1
        : rawVersion === 2 || rawVersion === '2'
          ? 2
          : (rawVersion as SyncContractVersion);
  return resolveSyncContract({
    contractVersion,
    idContract:
      typeof value.idContract === 'string' ? (value.idContract as SyncContractFields['idContract']) : undefined,
    hashContract:
      typeof value.hashContract === 'string' ? (value.hashContract as SyncContractFields['hashContract']) : undefined,
  });
}

export function sameSyncContract(left: ResolvedSyncContract, right: ResolvedSyncContract): boolean {
  return (
    left.contractVersion === right.contractVersion &&
    left.idContract === right.idContract &&
    left.hashContract === right.hashContract
  );
}

export function supportsSyncContract(capabilities: SyncCapabilities, contract: ResolvedSyncContract): boolean {
  return capabilities.supportedContracts.some((supported) => sameSyncContract(supported, contract));
}

export function withSyncContract(event: SyncEvent, contract: ResolvedSyncContract): SyncEvent {
  return { ...event, ...contract };
}

export function withoutSyncContract(event: SyncEvent): SyncEvent {
  const { contractVersion: _version, idContract: _id, hashContract: _hash, ...legacy } = event;
  return legacy;
}
