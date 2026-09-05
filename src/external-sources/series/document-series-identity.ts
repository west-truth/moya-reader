import { persistentId128 } from '@noveldesk/text-core/hash';
import type { ExternalItemKey } from '../contracts';

export function externalDocumentCollectionId(
  key: Pick<ExternalItemKey, 'connectorId' | 'accountConnectionId'>,
  collectionRemoteId: string,
): string {
  return persistentId128('external_series', [key.connectorId, key.accountConnectionId ?? '', collectionRemoteId]);
}

export function externalDocumentReleaseSourceId(key: ExternalItemKey, collectionRemoteId: string): string {
  return persistentId128('external_release', [
    key.connectorId,
    key.accountConnectionId ?? '',
    collectionRemoteId,
    key.remoteId,
  ]);
}
