export const SPEAKER_WORKFLOW_STORES = {
  sequenceDecisions: 'speaker_sequence_decisions',
  artifactDependencies: 'speaker_artifact_dependencies',
  speakerIdentities: 'speaker_identity_edges',
  voiceIdentities: 'speaker_voice_identities',
  acceptedSpeakerProvenance: 'accepted_speaker_provenance',
} as const;

function createBookStore(db: IDBDatabase, name: string): IDBObjectStore {
  const store = db.createObjectStore(name, { keyPath: 'id' });
  store.createIndex('bookId', 'bookId');
  return store;
}

export function upgradeSpeakerWorkflowStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(SPEAKER_WORKFLOW_STORES.sequenceDecisions)) {
    const store = createBookStore(db, SPEAKER_WORKFLOW_STORES.sequenceDecisions);
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('sceneId', 'sceneId');
    store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
    store.createIndex('packetFingerprint', 'packetFingerprint');
  }
  if (!db.objectStoreNames.contains(SPEAKER_WORKFLOW_STORES.artifactDependencies)) {
    const store = createBookStore(db, SPEAKER_WORKFLOW_STORES.artifactDependencies);
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('sceneId', 'sceneId');
    store.createIndex('artifactId', 'artifactId');
    store.createIndex('status', 'status');
    store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
  }
  if (!db.objectStoreNames.contains(SPEAKER_WORKFLOW_STORES.speakerIdentities)) {
    const store = createBookStore(db, SPEAKER_WORKFLOW_STORES.speakerIdentities);
    store.createIndex('speakerEntityId', 'speakerEntityId');
    store.createIndex('bookId_speakerEntityId', ['bookId', 'speakerEntityId']);
  }
  if (!db.objectStoreNames.contains(SPEAKER_WORKFLOW_STORES.voiceIdentities)) {
    const store = createBookStore(db, SPEAKER_WORKFLOW_STORES.voiceIdentities);
    store.createIndex('speakerEntityId', 'speakerEntityId');
    store.createIndex('voiceIdentityId', 'voiceIdentityId');
    store.createIndex('bookId_speakerEntityId', ['bookId', 'speakerEntityId']);
  }
  if (!db.objectStoreNames.contains(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance)) {
    const store = createBookStore(db, SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance);
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('speakerEntityId', 'speakerEntityId');
    store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
    store.createIndex('contentRevisionId_segmentId', ['contentRevisionId', 'segmentId']);
    store.createIndex('status', 'status');
  }
}
