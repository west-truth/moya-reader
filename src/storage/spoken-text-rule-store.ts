import type { SpokenTextRule } from '../domain/types';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { getAllRecords, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

export async function listSpokenTextRules(bookId?: string): Promise<SpokenTextRule[]> {
  const rules = await getAllRecords<SpokenTextRule>(DOCUMENT_LISTENING_STORES.spokenTextRules);
  return rules
    .filter((rule) => rule.scope === 'global' || (bookId !== undefined && rule.bookId === bookId))
    .sort((left, right) => left.priority - right.priority || left.updatedAt.localeCompare(right.updatedAt));
}

export async function saveSpokenTextRule(
  input: Omit<SpokenTextRule, 'id' | 'updatedAt'> & { readonly id?: string; readonly updatedAt?: string },
): Promise<SpokenTextRule> {
  const rule: SpokenTextRule = {
    ...input,
    id: input.id ?? `spoken_rule_${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
    pattern: input.pattern.trim(),
    replacement: input.replacement?.trim(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  if (!rule.pattern) throw new Error('Spoken text rule pattern is required.');
  if (rule.scope === 'book' && !rule.bookId) throw new Error('Book spoken text rule requires a book id.');
  const db = await openReaderDb();
  const tx = db.transaction(DOCUMENT_LISTENING_STORES.spokenTextRules, 'readwrite');
  tx.objectStore(DOCUMENT_LISTENING_STORES.spokenTextRules).put(rule);
  await transactionDone(tx);
  return rule;
}

export async function deleteSpokenTextRule(id: string): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(DOCUMENT_LISTENING_STORES.spokenTextRules, 'readwrite');
  tx.objectStore(DOCUMENT_LISTENING_STORES.spokenTextRules).delete(id);
  await transactionDone(tx);
}
