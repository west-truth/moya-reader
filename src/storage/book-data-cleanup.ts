import { deleteByIndexInTransaction } from './indexeddb-transaction';
import { SPEAKER_ATTRIBUTION_STORES } from './speaker-attribution-schema';
import { SPEAKER_WORKFLOW_STORES } from './speaker-workflow-schema';
import { TEMPORAL_CHARACTER_MEMORY_STORES } from './temporal-character-memory-schema';
import { VOICE_CASTING_STORES } from './voice-casting-schema';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';

const SPEAKER_BOOK_DATA_STORES = [
  ...Object.values(SPEAKER_ATTRIBUTION_STORES),
  ...Object.values(TEMPORAL_CHARACTER_MEMORY_STORES),
  ...Object.values(SPEAKER_WORKFLOW_STORES),
];
const SPEAKER_BOOK_DATA_STORE_SET = new Set<string>(SPEAKER_BOOK_DATA_STORES);
const DOCUMENT_BOOK_DATA_STORES = Object.values(DOCUMENT_LISTENING_STORES);
const DOCUMENT_BOOK_DATA_STORE_SET = new Set<string>(DOCUMENT_BOOK_DATA_STORES);

export const BOOK_DATA_STORES = [
  'chapters',
  'paragraphs',
  'paragraph_pages',
  'paragraph_search',
  'book_content_revisions',
  'book_content_chapters',
  'book_content_paragraphs',
  'book_content_paragraph_pages',
  'book_content_paragraph_search',
  'book_content_domain_heads',
  'native_analysis_workflows',
  'native_analysis_workflow_descriptors',
  'native_analysis_staging',
  'native_analysis_provenance',
  'bookmarks',
  'highlights',
  'notes',
  'segments',
  'characters',
  'character_relations',
  'voice_profiles',
  'voice_product_states',
  VOICE_CASTING_STORES.states,
  'corrections',
  'reading_positions',
  'sync_tombstones',
  'reader_anchor_quarantine',
  'chapter_structure_drafts',
  'chapter_structure_receipts',
  'chapter_structure_review',
  'shelf_memberships',
  'reading_session_events',
  ...DOCUMENT_BOOK_DATA_STORES,
  ...SPEAKER_BOOK_DATA_STORES,
] as const;

export function bookDataIndexName(storeName: (typeof BOOK_DATA_STORES)[number]): 'novelId' | 'bookId' {
  return storeName === 'shelf_memberships' ||
    storeName === 'reading_session_events' ||
    DOCUMENT_BOOK_DATA_STORE_SET.has(storeName) ||
    SPEAKER_BOOK_DATA_STORE_SET.has(storeName)
    ? 'bookId'
    : 'novelId';
}

export function deleteBookDataInTransaction(tx: IDBTransaction, novelId: string): void {
  for (const storeName of BOOK_DATA_STORES) {
    deleteByIndexInTransaction(tx, storeName, bookDataIndexName(storeName), novelId);
  }
}
