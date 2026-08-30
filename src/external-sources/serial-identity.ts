import { persistentId128 } from '@noveldesk/text-core/hash';

export interface ExternalSerialCollectionIdentity {
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly collectionRemoteId: string;
}

export function externalSerialCollectionKey(identity: ExternalSerialCollectionIdentity): string {
  return [identity.connectorId, identity.accountConnectionId ?? '', identity.collectionRemoteId].join('::');
}

export function externalSerialBookId(identity: ExternalSerialCollectionIdentity): string {
  return persistentId128('external_series', [externalSerialCollectionKey(identity)]);
}
