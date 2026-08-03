export const CHARACTER_GRAPH_V2_STORES = {
  facts: 'character_facts_v2',
  mentions: 'character_mentions_v2',
  addressTerms: 'character_address_terms_v2',
  speechTraits: 'character_speech_traits_v2',
  relationFacts: 'character_relation_facts_v2',
  evidence: 'character_evidence_v2',
  mergeCandidates: 'character_merge_candidates_v2',
  redirects: 'character_id_redirects_v2',
  receipts: 'character_identity_receipts_v2',
} as const;

function createStore(db: IDBDatabase, name: string): IDBObjectStore {
  const store = db.createObjectStore(name, { keyPath: 'id' });
  store.createIndex('novelId', 'novelId');
  return store;
}

export function upgradeCharacterGraphV2Stores(db: IDBDatabase): void {
  for (const name of Object.values(CHARACTER_GRAPH_V2_STORES)) {
    if (!db.objectStoreNames.contains(name)) createStore(db, name);
  }
}
