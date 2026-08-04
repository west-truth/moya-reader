import { describe, expect, it, vi } from 'vitest';
import { ParsedNovel } from '../domain/types';
import { ResourceRevisionConflictError } from '../domain/resource-revisions';
import {
  RemoteMutationConflictError,
  RemoteMutationProtocolError,
  RemoteReaderRepository,
} from '../repositories/remote-reader-repository';
import { RemoteApiClient, RemoteApiError } from '../services/remote/remote-api-client';

const now = '2026-07-05T00:00:00.000Z';

function parsedNovel(text: string): ParsedNovel {
  return {
    novel: {
      id: 'parsed_1',
      title: 'Parsed Remote Novel',
      sourceFileName: 'parsed-remote.txt',
      sourceEncoding: 'utf-8',
      rawText: text,
      normalizedText: '',
      rawTextHash: 'raw-hash',
      normalizedTextHash: 'normalized-hash',
      createdAt: now,
      updatedAt: now,
      totalChapters: 1,
      totalCharacters: text.length,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: 'chapter_1',
        novelId: 'parsed_1',
        index: 1,
        title: '1화',
        normalizedText: text,
        textHash: 'chapter-hash',
        rawStartOffset: 0,
        rawEndOffset: text.length,
        characterCount: text.length,
        paragraphCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs: [
      {
        id: 'paragraph_1',
        novelId: 'parsed_1',
        chapterId: 'chapter_1',
        index: 1,
        text,
        startOffsetInChapter: 0,
        endOffsetInChapter: text.length,
        textHash: 'paragraph-hash',
      },
    ],
  };
}

function mockClient(uploadedChunks: string[]) {
  return {
    initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
    putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number, chunk: Blob) => {
      uploadedChunks[chunkIndex] = await chunk.text();
      return { ok: true as const };
    }),
    completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
    getImportJob: vi.fn(async () => ({
      id: 'job_1',
      upload_id: 'upload_1',
      status: 'done' as const,
      book_id: 'book_1',
    })),
    getBookManifest: vi.fn(async () => ({
      book: {
        id: 'book_1',
        title: 'Imported Remote Novel',
        source_file_name: 'parsed-remote.txt',
        source_encoding: 'utf-8',
        normalized_text_hash: 'server-hash',
        created_at: now,
        updated_at: now,
        total_chapters: 1,
        total_characters: 10,
        total_paragraphs: 1,
        cover_seed: 1,
        favorite: false,
      },
      readingPosition: null,
    })),
  } as unknown as RemoteApiClient;
}

function hostedClient() {
  const paragraph = {
    id: 'paragraph_9',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 9,
    text: 'Server page paragraph',
    startOffsetInChapter: 120,
    endOffsetInChapter: 141,
    textHash: 'paragraph-hash',
  };
  const page = {
    id: 'page_chapter_1_0',
    book_id: 'book_1',
    chapter_id: 'chapter_1',
    page_index: 0,
    start_paragraph_index: 1,
    end_paragraph_index: 20,
    paragraphs: [paragraph],
    text_hash: 'page-hash',
  };

  return {
    listBooks: vi.fn(async () => ({
      books: [
        {
          id: 'book_1',
          title: 'Hosted Novel',
          source_file_name: 'hosted.txt',
          source_encoding: 'utf-8',
          normalized_text_hash: 'book-hash',
          created_at: now,
          updated_at: now,
          total_chapters: 1,
          total_characters: 1000,
          total_paragraphs: 40,
          cover_seed: 7,
          favorite: true,
          last_read_chapter_id: 'chapter_1',
          last_read_paragraph_id: 'paragraph_9',
          last_read_offset: 240,
          last_read_progress: 0.45,
        },
      ],
    })),
    getBookManifest: vi.fn(async () => ({
      book: {
        id: 'book_1',
        title: 'Hosted Novel',
        source_file_name: 'hosted.txt',
        source_encoding: 'utf-8',
        normalized_text_hash: 'book-hash',
        created_at: now,
        updated_at: now,
        total_chapters: 1,
        total_characters: 1000,
        total_paragraphs: 40,
        cover_seed: 7,
        favorite: true,
      },
      readingPosition: {
        book_id: 'book_1',
        chapter_id: 'chapter_1',
        paragraph_id: 'paragraph_9',
        paragraph_index: 9,
        offset_in_paragraph: 4,
        chapter_progress: 0.45,
        scroll_top: 240,
        device_id: 'server_session',
        updated_at: '2026-07-05T00:05:00.000Z',
      },
    })),
    listChapters: vi.fn(async () => ({
      chapters: [
        {
          id: 'chapter_1',
          book_id: 'book_1',
          chapter_index: 1,
          title: '1화',
          text_hash: 'chapter-hash',
          raw_start_offset: 0,
          raw_end_offset: 1000,
          character_count: 1000,
          paragraph_count: 40,
          created_at: now,
          updated_at: now,
        },
      ],
    })),
    listPages: vi.fn(async (_chapterId: string, from = 0, count = 5) => ({
      pages: from === 0 && count >= 1 ? [page] : [],
    })),
    listBookmarks: vi.fn(async () => ({
      bookmarks: [
        {
          id: 'bookmark_1',
          book_id: 'book_1',
          chapter_id: 'chapter_1',
          paragraph_id: 'paragraph_9',
          label: 'Return here',
          progress: 0.45,
          scroll_top: 240,
          created_at: now,
        },
      ],
    })),
    listHighlights: vi.fn(async () => ({
      highlights: [
        {
          id: 'highlight_1',
          book_id: 'book_1',
          chapter_id: 'chapter_1',
          paragraph_id: 'paragraph_9',
          quote: 'Server page paragraph',
          color: 'yellow',
          progress: 0.45,
          created_at: now,
          updated_at: now,
        },
      ],
    })),
    listNotes: vi.fn(async () => ({
      notes: [
        {
          id: 'note_1',
          book_id: 'book_1',
          chapter_id: 'chapter_1',
          paragraph_id: 'paragraph_9',
          quote: 'Server page paragraph',
          body: 'Remote note',
          progress: 0.45,
          created_at: now,
          updated_at: now,
        },
      ],
    })),
    saveBookmark: vi.fn(async () => ({ ok: true as const, applied: true })),
    saveHighlight: vi.fn(async () => ({ ok: true as const, applied: true })),
    saveNote: vi.fn(async () => ({ ok: true as const, applied: true })),
    patchBook: vi.fn(async () => ({ ok: true as const })),
    saveReadingPosition: vi.fn(async () => ({ ok: true as const, applied: true })),
    deleteReadingPosition: vi.fn(async () => ({ ok: true as const, applied: true })),
    listCharacters: vi.fn(async () => ({
      characters: [
        {
          id: 'char_1',
          novelId: 'book_1',
          canonicalName: '강현우',
          aliases: ['현우'],
          color: '#3b82f6',
          confidence: 0.91,
          isUserConfirmed: false,
        },
      ],
    })),
    saveCharacters: vi.fn(async () => ({ ok: true as const, characters: [] })),
    saveCharacterGraph: vi.fn(async (_bookId, graph) => ({ ok: true as const, graph })),
    listVoiceProfiles: vi.fn(async () => ({
      voiceProfiles: [
        {
          id: 'voice_char_1',
          novelId: 'book_1',
          characterId: 'char_1',
          role: 'character' as const,
          providerId: 'system',
          providerVoiceId: 'ko-KR-local',
          label: '강현우 음성',
          language: 'ko-KR',
          speed: 1,
          providerOptions: {},
          isUserSelected: true,
        },
      ],
    })),
    saveVoiceProfiles: vi.fn(async () => ({ ok: true as const, voiceProfiles: [] })),
    listSegments: vi.fn(async () => ({
      segments: [
        {
          id: 'seg_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: 'paragraph_9',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 21,
          segmentTextHash: 'hash_seg',
          type: 'narration',
          speakerId: 'narrator',
          candidateSpeakers: [],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 0.99,
          isUserCorrected: false,
        },
      ],
    })),
    saveSegments: vi.fn(async () => ({ ok: true as const, segments: [] })),
    saveCorrection: vi.fn(async () => ({ ok: true as const, correction: {} })),
    deleteCorrection: vi.fn(async () => ({ ok: true as const, id: 'correction_1', deletedAt: now })),
  } as unknown as RemoteApiClient;
}

describe('RemoteReaderRepository', () => {
  it('maps hosted books, page data, and reader annotations through the repository boundary', async () => {
    const client = hostedClient();
    const repository = new RemoteReaderRepository(client);

    const [listedNovel] = await repository.listNovels();
    const manifestNovel = await repository.getNovel('book_1');
    const [chapter] = await repository.listChapters('book_1');
    const page = await repository.getParagraphPage('chapter_1', 0);
    const [bookmark] = await repository.listBookmarks('book_1');
    const [highlight] = await repository.listHighlights('book_1');
    const [note] = await repository.listNotes('book_1');

    expect(listedNovel).toMatchObject({
      id: 'book_1',
      title: 'Hosted Novel',
      rawText: '',
      normalizedText: '',
      lastReadChapterId: 'chapter_1',
      lastReadParagraphId: 'paragraph_9',
      lastReadOffset: 240,
      lastReadProgress: 0.45,
    });
    expect(manifestNovel).toMatchObject({
      id: 'book_1',
      lastReadChapterId: 'chapter_1',
      lastReadParagraphId: 'paragraph_9',
      lastReadOffset: 240,
      lastReadProgress: 0.45,
      updatedAt: '2026-07-05T00:05:00.000Z',
    });
    expect(chapter).toMatchObject({ id: 'chapter_1', novelId: 'book_1', index: 1, title: '1화' });
    expect(page).toMatchObject({
      id: 'page_chapter_1_0',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      pageIndex: 0,
      startParagraphIndex: 1,
      endParagraphIndex: 20,
      paragraphs: [expect.objectContaining({ id: 'paragraph_9', text: 'Server page paragraph' })],
    });
    expect(bookmark).toMatchObject({ id: 'bookmark_1', novelId: 'book_1', paragraphId: 'paragraph_9' });
    expect(highlight).toMatchObject({
      id: 'highlight_1',
      novelId: 'book_1',
      paragraphId: 'paragraph_9',
      color: 'yellow',
    });
    expect(note).toMatchObject({ id: 'note_1', novelId: 'book_1', paragraphId: 'paragraph_9', body: 'Remote note' });
  });

  it('patches only the requested hosted book metadata fields', async () => {
    const client = hostedClient();
    const repository = new RemoteReaderRepository(client);

    await repository.patchNovelMetadata('book_1', {
      title: 'Title change',
      favorite: false,
      analysisStatus: 'queued',
    });

    expect(client.patchBook).toHaveBeenCalledWith('book_1', {
      title: 'Title change',
      favorite: false,
      analysisStatus: 'queued',
    });
  });

  it('saves hosted reading positions with clamped progress and paragraph offsets', async () => {
    const client = hostedClient();
    const repository = new RemoteReaderRepository(client, 'device_browser_a');

    await repository.saveReadingPosition({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      scrollTop: 123.7,
      chapterProgress: 1.5,
      paragraphId: 'paragraph_9',
      paragraphIndex: 9,
      offsetInParagraph: 4,
    });

    expect(client.saveReadingPosition).toHaveBeenCalledWith(
      'book_1',
      expect.objectContaining({
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_9',
        paragraphIndex: 9,
        offsetInParagraph: 4,
        chapterProgress: 1,
        scrollTop: 124,
        deviceId: 'device_browser_a',
      }),
    );
    expect(client.saveReadingPosition).toHaveBeenCalledWith(
      'book_1',
      expect.objectContaining({
        updatedAt: expect.any(String),
      }),
    );
  });

  it('clears hosted reading positions through the remote repository boundary', async () => {
    const client = hostedClient();
    const repository = new RemoteReaderRepository(client, 'device_browser_a');

    await repository.clearReadingPosition('book_1');

    expect(client.deleteReadingPosition).toHaveBeenCalledWith('book_1', {
      deviceId: 'device_browser_a',
      updatedAt: expect.any(String),
    });
  });

  it('persists hosted AI characters, segments, and corrections through the remote repository boundary', async () => {
    const client = hostedClient();
    const repository = new RemoteReaderRepository(client);
    const [character] = await repository.listCharacters('book_1');
    const [voiceProfile] = await repository.listVoiceProfiles('book_1');
    const [segment] = await repository.listSegments('chapter_1');
    const correction = {
      id: 'correction_1',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_9',
      segmentId: 'seg_1',
      correctionType: 'speaker' as const,
      beforeJson: JSON.stringify({ speakerId: 'unknown' }),
      afterJson: JSON.stringify({ speakerId: 'char_1' }),
      applyScope: 'chapter' as const,
      createdAt: now,
    };

    expect(character).toMatchObject({ id: 'char_1', novelId: 'book_1', canonicalName: '강현우' });
    expect(voiceProfile).toMatchObject({
      id: 'voice_char_1',
      novelId: 'book_1',
      characterId: 'char_1',
      providerVoiceId: 'ko-KR-local',
    });
    expect(segment).toMatchObject({ id: 'seg_1', novelId: 'book_1', chapterId: 'chapter_1', speakerId: 'narrator' });

    await repository.saveCharacters('book_1', [character]);
    const relation = {
      id: 'rel_1',
      novelId: 'book_1',
      sourceCharacterId: 'char_1',
      targetCharacterId: 'char_2',
      relationLabel: 'mentor',
      termsUsedBySource: ['teacher'],
      termsUsedByTarget: ['student'],
      confidence: 0.7,
      evidence: ['chapter_1'],
    };
    await repository.saveCharacterGraph('book_1', {
      characters: [character],
      relations: [relation],
    });
    await repository.saveVoiceProfiles('book_1', [voiceProfile]);
    await repository.saveSegments('chapter_1', [segment]);
    await repository.saveCorrection(correction);
    await repository.deleteCorrection('book_1', correction.id);

    expect(client.saveCharacters).toHaveBeenCalledWith('book_1', [character]);
    expect(client.saveCharacterGraph).toHaveBeenCalledWith('book_1', {
      novelId: 'book_1',
      characters: [character],
      relations: [relation],
    });
    expect(client.saveVoiceProfiles).toHaveBeenCalledWith('book_1', [voiceProfile]);
    expect(client.saveSegments).toHaveBeenCalledWith('chapter_1', [segment]);
    expect(client.saveCorrection).toHaveBeenCalledWith(correction);
    expect(client.deleteCorrection).toHaveBeenCalledWith('book_1', correction.id);
  });

  it('rejects hosted mutations that the server reports as not applied', async () => {
    const client = hostedClient();
    vi.mocked(client.saveReadingPosition).mockResolvedValue({ ok: true, applied: false });
    vi.mocked(client.deleteReadingPosition).mockResolvedValue({ ok: true, applied: false });
    vi.mocked(client.saveBookmark).mockResolvedValue({ ok: true, applied: false });
    vi.mocked(client.saveHighlight).mockResolvedValue({ ok: true, applied: false });
    vi.mocked(client.saveNote).mockResolvedValue({ ok: true, applied: false });
    const repository = new RemoteReaderRepository(client);
    const createdAt = '2026-07-05T00:06:00.000Z';

    await expect(
      repository.saveReadingPosition({
        novelId: 'book_1',
        chapterId: 'chapter_1',
        scrollTop: 10,
        chapterProgress: 0.2,
        paragraphIndex: 0,
      }),
    ).rejects.toBeInstanceOf(RemoteMutationConflictError);
    await expect(repository.clearReadingPosition('book_1')).rejects.toBeInstanceOf(RemoteMutationConflictError);
    await expect(
      repository.saveBookmark({
        id: 'bookmark_stale',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        label: 'Stale bookmark',
        progress: 0.2,
        scrollTop: 10,
        createdAt,
      }),
    ).rejects.toMatchObject({ operation: 'bookmark' });
    await expect(
      repository.saveHighlight({
        id: 'highlight_stale',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_9',
        quote: 'Server page paragraph',
        color: 'yellow',
        progress: 0.2,
        createdAt,
        updatedAt: createdAt,
      }),
    ).rejects.toMatchObject({ operation: 'highlight' });
    await expect(
      repository.saveNote({
        id: 'note_stale',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_9',
        body: 'Stale note',
        progress: 0.2,
        createdAt,
        updatedAt: createdAt,
      }),
    ).rejects.toMatchObject({ operation: 'note' });
  });

  it('preserves the server revision when a guarded resource mutation conflicts', async () => {
    const client = hostedClient();
    vi.mocked(client.saveSegments).mockRejectedValue(
      new RemoteApiError(JSON.stringify({ actualRevision: 'server-revision' }), 409),
    );
    const repository = new RemoteReaderRepository(client);

    const error = await repository
      .saveSegments('chapter_1', [], { expectedRevision: 'client-revision' })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResourceRevisionConflictError);
    expect(error).toMatchObject({
      resourceKind: 'chapter_segments',
      expectedRevision: 'client-revision',
      actualRevision: 'server-revision',
    });
  });

  it('fails closed when a guarded mutation response omits applied', async () => {
    const client = hostedClient();
    vi.mocked(client.saveReadingPosition).mockResolvedValue({ ok: true } as never);
    const repository = new RemoteReaderRepository(client);

    await expect(
      repository.saveReadingPosition({
        novelId: 'book_1',
        chapterId: 'chapter_1',
        scrollTop: 10,
        chapterProgress: 0.2,
        paragraphIndex: 0,
      }),
    ).rejects.toBeInstanceOf(RemoteMutationProtocolError);

    vi.mocked(client.saveReadingPosition).mockResolvedValue({ ok: false, applied: true } as never);
    await expect(
      repository.saveReadingPosition({
        novelId: 'book_1',
        chapterId: 'chapter_1',
        scrollTop: 10,
        chapterProgress: 0.2,
        paragraphIndex: 0,
      }),
    ).rejects.toBeInstanceOf(RemoteMutationProtocolError);
  });

  it('rejects unsupported hosted persistence commands instead of reporting fake success', async () => {
    const repository = new RemoteReaderRepository(hostedClient());

    expect(repository.capabilities).toMatchObject({
      readingTimePersistence: 'session_only',
      syncStorage: 'remote_backend',
      remoteEventApply: false,
      parsedNovelImport: 'upload_reparse',
    });
    expect('addNovelReadingTime' in repository).toBe(false);
    expect('applyRemoteSyncEvents' in repository).toBe(false);
    expect('discardSyncOutboxItems' in repository).toBe(false);
    await expect(repository.getSyncState()).resolves.not.toHaveProperty('lastSyncedAt');
  });

  it('uploads fallback parsed novels through bounded chunks', async () => {
    const chunkBytes = 2 * 1024 * 1024;
    const source = 'a'.repeat(chunkBytes + 13);
    const uploadedChunks: string[] = [];
    const client = mockClient(uploadedChunks);
    const repository = new RemoteReaderRepository(client);

    await repository.saveImportedNovel(parsedNovel(source));

    expect(client.initUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        encoding: 'utf-8',
        clientBookId: 'parsed_1',
        sizeBytes: source.length,
        totalChunks: 2,
      }),
    );
    expect(client.putUploadChunk).toHaveBeenCalledTimes(2);
    expect(client.putUploadChunk).toHaveBeenNthCalledWith(1, 'upload_1', 0, expect.any(Blob));
    expect(client.putUploadChunk).toHaveBeenNthCalledWith(2, 'upload_1', 1, expect.any(Blob));
    expect(uploadedChunks.map((chunk) => chunk.length)).toEqual([chunkBytes, 13]);
    expect(client.completeUpload).toHaveBeenCalledWith('upload_1');
  });

  it('reconstructs fallback upload text from chapter pages when parsed text payloads are empty', async () => {
    const uploadedChunks: string[] = [];
    const client = mockClient(uploadedChunks);
    const repository = new RemoteReaderRepository(client);
    const parsed = parsedNovel('본문 문단');
    parsed.novel.rawText = '';
    parsed.novel.normalizedText = '';
    parsed.chapters[0].normalizedText = '';

    await repository.saveImportedNovel(parsed);

    expect(client.initUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        sizeBytes: new Blob(['1화\n\n본문 문단']).size,
        totalChunks: 1,
      }),
    );
    expect(uploadedChunks).toEqual(['1화\n\n본문 문단']);
  });
});
