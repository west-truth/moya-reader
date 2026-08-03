interface ConnectedProviderAttachClient {
  getBookManifest(bookId: string): Promise<unknown>;
  listChapters(bookId: string): Promise<{ chapters: Array<Record<string, unknown>> }>;
}

export interface ConnectedProviderExpectedAttachment {
  readonly normalizedTextHash?: string;
  readonly chapterTextHashById?: Readonly<Record<string, string | undefined>>;
}

export type ConnectedProviderAttachCheck =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing_book' | 'missing_chapter' | 'stale_book' | 'stale_chapter';
      chapterId?: string;
    };

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export async function verifyConnectedProviderServerBookAttached(
  client: ConnectedProviderAttachClient,
  bookId: string,
  chapterIds: readonly string[] = [],
  expected: ConnectedProviderExpectedAttachment = {},
): Promise<ConnectedProviderAttachCheck> {
  let manifest: unknown;
  try {
    manifest = await client.getBookManifest(bookId);
  } catch {
    return { ok: false, reason: 'missing_book' };
  }

  const manifestRecord = objectRecord(manifest);
  const bookRecord = objectRecord(manifestRecord?.book) ?? manifestRecord;
  const expectedBookHash = expected.normalizedTextHash?.trim();
  const serverBookHash = stringField(bookRecord, 'normalizedTextHash', 'normalized_text_hash');
  if (expectedBookHash && serverBookHash !== expectedBookHash) {
    return { ok: false, reason: 'stale_book' };
  }

  if (chapterIds.length === 0) return { ok: true };

  try {
    const response = await client.listChapters(bookId);
    const chapterById = new Map(response.chapters
      .map((chapter) => [stringField(chapter, 'id'), chapter] as const)
      .filter((entry): entry is readonly [string, Record<string, unknown>] => Boolean(entry[0])));
    const serverChapterIds = new Set(chapterById.keys());
    const missingChapterId = chapterIds.find((chapterId) => !serverChapterIds.has(chapterId));
    if (missingChapterId) return { ok: false, reason: 'missing_chapter', chapterId: missingChapterId };

    const staleChapterId = chapterIds.find((chapterId) => {
      const expectedChapterHash = expected.chapterTextHashById?.[chapterId]?.trim();
      if (!expectedChapterHash) return false;
      const serverChapterHash = stringField(chapterById.get(chapterId), 'textHash', 'text_hash');
      return serverChapterHash !== expectedChapterHash;
    });
    return staleChapterId
      ? { ok: false, reason: 'stale_chapter', chapterId: staleChapterId }
      : { ok: true };
  } catch {
    return { ok: false, reason: 'missing_chapter', chapterId: chapterIds[0] };
  }
}
