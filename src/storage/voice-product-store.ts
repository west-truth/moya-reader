import type { VoiceProductStateV1 } from '../providers/voice-product';
import { emptyVoiceProductState } from '../providers/voice-product';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

interface StoredVoiceProductState {
  readonly id: string;
  readonly novelId: string;
  readonly state: VoiceProductStateV1;
}

export async function getVoiceProductState(novelId: string): Promise<VoiceProductStateV1> {
  const db = await openReaderDb();
  const tx = db.transaction('voice_product_states', 'readonly');
  const row = await requestToPromise<StoredVoiceProductState | undefined>(
    tx.objectStore('voice_product_states').index('novelId').get(novelId),
  );
  await transactionDone(tx);
  return row?.state ?? emptyVoiceProductState(novelId);
}

export async function saveVoiceProductState(novelId: string, state: VoiceProductStateV1): Promise<void> {
  if (state.novelId !== novelId) throw new Error('voice product state novelId does not match target novel');
  const db = await openReaderDb();
  const tx = db.transaction('voice_product_states', 'readwrite');
  tx.objectStore('voice_product_states').put({ id: `voice_product_state_${novelId}`, novelId, state });
  await transactionDone(tx);
}
