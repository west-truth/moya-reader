import {
  SYNC_CONTRACT_V1,
  SYNC_CONTRACT_V2,
  parseSyncContractFields,
  resolveSyncContract,
  sameSyncContract,
  supportsSyncContract,
  withoutSyncContract,
} from '../../sync/contract';
import type {
  JsonValue,
  NegotiatedSyncContract,
  PullSyncResult,
  PushSyncResult,
  ResolvedSyncContract,
  SyncCapabilities,
  SyncEvent,
  SyncEventType,
} from '../../sync/types';
import { RemoteApiError } from './remote-api-contracts';

type JsonRecord = Record<string, unknown>;

export interface RemoteJsonRequester {
  request(path: string, init?: RequestInit): Promise<unknown>;
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

export function mapServerSyncEvent(row: JsonRecord): SyncEvent {
  const contract = parseSyncContractFields({
    contractVersion: row.contractVersion ?? row.contract_version,
    idContract: row.idContract ?? row.id_contract,
    hashContract: row.hashContract ?? row.hash_contract,
  });
  return {
    ...contract,
    sequence: typeof row.sequence === 'number' ? row.sequence : undefined,
    id: stringValue(row.id),
    type: stringValue(row.type) as SyncEventType,
    deviceId: stringValue(row.device_id ?? row.deviceId, 'server'),
    novelId: stringValue(row.book_id ?? row.novelId) || undefined,
    entityId: stringValue(row.entity_id ?? row.entityId) || undefined,
    payload: jsonValue(row.payload),
    revision:
      row.revision && typeof row.revision === 'object' && !Array.isArray(row.revision)
        ? (row.revision as SyncEvent['revision'])
        : undefined,
    createdAt: stringValue(row.created_at ?? row.createdAt, new Date(0).toISOString()),
  };
}

function mapSyncCapabilities(row: JsonRecord): SyncCapabilities {
  const current = parseSyncContractFields(row);
  const supportedRows = Array.isArray(row.supportedContracts) ? row.supportedContracts : [];
  const supportedContracts = supportedRows.map((value) =>
    parseSyncContractFields(value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}),
  );
  const defaultPullRow =
    row.defaultPullContract && typeof row.defaultPullContract === 'object' && !Array.isArray(row.defaultPullContract)
      ? (row.defaultPullContract as JsonRecord)
      : row;
  const defaultPullContract = parseSyncContractFields(defaultPullRow);
  if (!supportedContracts.some((contract) => sameSyncContract(contract, current))) supportedContracts.push(current);
  return { ...current, supportedContracts, defaultPullContract };
}

interface CapabilityResolution {
  capabilities: SyncCapabilities;
  legacyServer: boolean;
}

export class RemoteSyncTransport {
  private capabilityPromise?: Promise<CapabilityResolution>;

  constructor(private readonly requester: RemoteJsonRequester) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (init === undefined ? this.requester.request(path) : this.requester.request(path, init))) as T;
  }

  private capabilities(): Promise<CapabilityResolution> {
    if (this.capabilityPromise) return this.capabilityPromise;
    const capabilityPromise = (async () => {
      try {
        return {
          capabilities: mapSyncCapabilities(await this.request<JsonRecord>('/sync/capabilities')),
          legacyServer: false,
        };
      } catch (error) {
        if (!(error instanceof RemoteApiError) || (error.status !== 404 && error.status !== 405)) throw error;
        return {
          capabilities: {
            ...SYNC_CONTRACT_V1,
            supportedContracts: [SYNC_CONTRACT_V1],
            defaultPullContract: SYNC_CONTRACT_V1,
          },
          legacyServer: true,
        };
      }
    })();
    this.capabilityPromise = capabilityPromise;
    void capabilityPromise.catch(() => {
      if (this.capabilityPromise === capabilityPromise) this.capabilityPromise = undefined;
    });
    return capabilityPromise;
  }

  async negotiateSyncContract(): Promise<NegotiatedSyncContract> {
    const resolved = await this.capabilities();
    if (supportsSyncContract(resolved.capabilities, SYNC_CONTRACT_V2)) {
      return { descriptor: SYNC_CONTRACT_V2, legacyServer: resolved.legacyServer };
    }
    if (supportsSyncContract(resolved.capabilities, SYNC_CONTRACT_V1)) {
      return { descriptor: SYNC_CONTRACT_V1, legacyServer: resolved.legacyServer };
    }
    throw new Error('The server exposes no supported sync contract.');
  }

  async getSyncCapabilities(): Promise<SyncCapabilities> {
    return (await this.capabilities()).capabilities;
  }

  async pullSync(since = 0, requestedContract?: ResolvedSyncContract): Promise<PullSyncResult> {
    const negotiation = await this.negotiateSyncContract();
    const contract = requestedContract ?? negotiation.descriptor;
    if (negotiation.legacyServer && contract.contractVersion !== 1) {
      throw new Error('A legacy sync server cannot return v2 identities.');
    }
    const query = negotiation.legacyServer
      ? `/sync?since=${since}`
      : `/sync?since=${since}&contractVersion=${contract.contractVersion}&idContract=${encodeURIComponent(contract.idContract)}&hashContract=${encodeURIComponent(contract.hashContract)}`;
    const response = await this.request<{ cursor: number; events: JsonRecord[] } & JsonRecord>(query);
    const responseContract = parseSyncContractFields({
      contractVersion: response.contractVersion,
      idContract: response.idContract,
      hashContract: response.hashContract,
    });
    if (!sameSyncContract(responseContract, contract)) {
      throw new Error('The server returned a different sync contract than requested.');
    }
    return {
      ...responseContract,
      cursor: response.cursor,
      events: response.events.map(mapServerSyncEvent),
    };
  }

  async pushSync(events: SyncEvent[], requestedContract?: ResolvedSyncContract): Promise<PushSyncResult> {
    const negotiation = await this.negotiateSyncContract();
    const contract = requestedContract ?? negotiation.descriptor;
    if (negotiation.legacyServer || contract.contractVersion === 1) {
      const incompatible = events.find((event) => resolveSyncContract(event).contractVersion !== 1);
      if (incompatible) throw new Error(`Refusing to send v2 sync event ${incompatible.id} to a v1 server.`);
    }
    const body = negotiation.legacyServer ? { events: events.map(withoutSyncContract) } : { ...contract, events };
    const response = await this.request<PushSyncResult>('/sync/events', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { ...parseSyncContractFields(response), ...response };
  }
}
