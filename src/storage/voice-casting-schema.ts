export const VOICE_CASTING_STORES = {
  states: 'voice_casting_states',
} as const;

export function upgradeVoiceCastingStores(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(VOICE_CASTING_STORES.states)) return;
  const store = db.createObjectStore(VOICE_CASTING_STORES.states, { keyPath: 'id' });
  store.createIndex('novelId', 'novelId', { unique: true });
}
