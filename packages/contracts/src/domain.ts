export type EncodingMode = 'auto' | 'utf-8' | 'euc-kr';
export type ChapterSplitMode = 'auto' | 'mixed' | 'single';
export type BookFormat = 'txt' | 'markdown' | 'epub' | 'pdf' | 'image_archive';
export type BookAssetKind = 'source' | 'cover' | 'epub_resource' | 'document_page' | 'user_font';
export type BookAssetProvenance =
  | 'original'
  | 'canonical_reconstruction'
  | 'user_supplied'
  | 'epub_embedded'
  | 'archive_embedded'
  | 'generated_preview';
export type BookAssetStatus = 'staged' | 'active' | 'superseded';

export interface BookAssetMetadata {
  id: string;
  bookId: string;
  contentRevisionId?: string;
  kind: BookAssetKind;
  provenance: BookAssetProvenance;
  status: BookAssetStatus;
  storageKey: string;
  fileName?: string;
  contentType: string;
  byteLength: number;
  contentHash: string;
  encoding?: EncodingMode;
  pixelWidth?: number;
  pixelHeight?: number;
  pageIndex?: number;
  createdAt: string;
  activatedAt?: string;
}

export type ReaderTheme = 'light' | 'dark' | 'sepia' | 'midnight';
export type ReaderFont = 'serif' | 'sans' | 'mono';
export type ReaderFlow = 'scroll' | 'page';

export type ReadingProfileTheme = ReaderTheme | 'custom';
export type ReadingProfileFlow = 'scroll' | 'screen_turn' | 'paginated';

export interface ReadingProfile {
  schemaVersion: 1;
  theme: ReadingProfileTheme;
  fontId: 'builtin-serif' | 'builtin-sans' | 'builtin-mono' | string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  firstLineIndent: number;
  textAlign: 'start' | 'justify';
  marginX: number;
  marginY: number;
  contentWidth: number;
  foreground?: string;
  background?: string;
  brightness: number;
  flow: ReadingProfileFlow;
}

export type ReadingProfileOverride = Partial<Omit<ReadingProfile, 'schemaVersion'>>;

export type ReaderAction =
  'previous_page' | 'next_page' | 'toggle_chrome' | 'open_toc' | 'open_settings' | 'toggle_tts' | 'none';

export interface GestureBindings {
  tapLeft: ReaderAction;
  tapCenter: ReaderAction;
  tapRight: ReaderAction;
  swipeLeft: ReaderAction;
  swipeRight: ReaderAction;
  volumeUp?: ReaderAction;
  volumeDown?: ReaderAction;
}

export type UserFontContentType =
  'font/woff2' | 'font/woff' | 'font/ttf' | 'font/otf' | 'application/font-woff' | 'application/octet-stream';

export interface UserFontAsset {
  id: string;
  familyLabel: string;
  fileName: string;
  style: 'normal' | 'italic';
  weight: number;
  contentHash: string;
  contentType: UserFontContentType;
  byteLength: number;
  storageKey: string;
  licenseNote?: string;
  createdAt: string;
  updatedAt: string;
}

export type ReadingSessionMode = 'reading' | 'listening';

export interface ReadingSessionEvent {
  id: string;
  deviceId: string;
  bookId: string;
  mode: ReadingSessionMode;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  startAnchor?: ReaderAnchor;
  endAnchor?: ReaderAnchor;
  charactersAdvanced?: number;
  operationId: string;
}

export type SegmentType =
  | 'narration'
  | 'quoted_dialogue'
  | 'plain_dialogue'
  | 'inner_monologue'
  | 'system_message'
  | 'sfx'
  | 'author_note'
  | 'unknown';

export type AnalysisStatus =
  | 'not_analyzed'
  | 'mock_ready'
  | 'queued'
  | 'building_graph'
  | 'analyzing_characters'
  | 'labeling_segments'
  | 'validating'
  | 'ready'
  | 'needs_review'
  | 'failed'
  | 'cancelled';

export interface Novel {
  id: string;
  activeContentRevisionId?: string;
  sourceAssetId?: string;
  sourceProvenance?: BookAssetProvenance;
  sourceByteLength?: number;
  sourceContentType?: string;
  sourceContentHash?: string;
  format?: BookFormat;
  title: string;
  author?: string;
  seriesTitle?: string;
  seriesIndex?: number;
  tags?: string[];
  description?: string;
  language?: string;
  readingDirection?: 'ltr' | 'rtl';
  coverAssetId?: string;
  coverContentHash?: string;
  coverFit?: 'crop' | 'contain';
  coverPositionX?: number;
  coverPositionY?: number;
  sourceFileName: string;
  sourceEncoding?: EncodingMode;
  rawText: string;
  normalizedText: string;
  rawTextHash: string;
  normalizedTextHash: string;
  createdAt: string;
  updatedAt: string;
  totalChapters: number;
  totalCharacters: number;
  totalParagraphs: number;
  coverSeed: number;
  lastReadChapterId?: string;
  lastReadChapterIndex?: number;
  lastReadParagraphId?: string;
  lastReadOffset: number;
  lastReadProgress: number;
  readingSeconds?: number;
  lastReadAt?: string;
  favorite: boolean;
  analysisStatus: AnalysisStatus;
  metadataRevision?: number;
  deletedAt?: string;
  deletedByDeviceId?: string;
}

export interface Shelf {
  id: string;
  name: string;
  color?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ShelfMembership {
  id: string;
  shelfId: string;
  bookId: string;
  createdAt: string;
}

export interface Chapter {
  id: string;
  novelId: string;
  index: number;
  title: string;
  normalizedText: string;
  textHash: string;
  rawStartOffset: number;
  rawEndOffset: number;
  characterCount: number;
  paragraphCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Paragraph {
  id: string;
  novelId: string;
  chapterId: string;
  index: number;
  text: string;
  startOffsetInChapter: number;
  endOffsetInChapter: number;
  textHash: string;
  documentKind?: ReaderDocumentBlockKind;
  inlineMarks?: ReaderDocumentInlineMark[];
  inlineSemantics?: ReaderDocumentInlineSemantic[];
  assetId?: string;
  sourceHref?: string;
  documentPageType?: string;
  documentPageDouble?: boolean;
  sourceLocator?: ReaderAnchorSourceLocator;
}

export interface ParagraphPage {
  id: string;
  novelId: string;
  chapterId: string;
  pageIndex: number;
  startParagraphIndex: number;
  endParagraphIndex: number;
  paragraphs: Paragraph[];
  textHash: string;
}

export interface ReadingPosition {
  id: string;
  novelId: string;
  chapterId: string;
  paragraphId?: string;
  paragraphIndex: number;
  offsetInParagraph: number;
  chapterProgress: number;
  scrollTop: number;
  deviceId: string;
  updatedAt: string;
  anchor?: ReaderAnchor;
}

export type ReaderAnchorSourceLocator = { kind: 'text_offset'; value: number } | { kind: 'epub_cfi'; value: string };

export interface ReaderAnchor {
  bookId: string;
  contentRevisionId: string;
  sectionId: string;
  blockId: string;
  blockIndex?: number;
  offset: number;
  sourceLocator?: ReaderAnchorSourceLocator;
}

export interface TextQuad {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DocumentAnchor =
  | {
      kind: 'reflowable_text';
      reader: ReaderAnchor;
      paragraphId: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: 'fixed_page';
      bookId: string;
      pageIndex: number;
      pageHash: string;
    }
  | {
      kind: 'fixed_text';
      bookId: string;
      pageIndex: number;
      textRevisionId: string;
      blockId: string;
      startOffset: number;
      endOffset: number;
      blockRanges?: Array<{ blockId: string; startOffset: number; endOffset: number }>;
      quads?: TextQuad[];
    }
  | {
      kind: 'fixed_region';
      bookId: string;
      pageIndex: number;
      pageHash: string;
      quads: TextQuad[];
    };

export interface DocumentAnnotation {
  id: string;
  bookId: string;
  pageIndex: number;
  type: 'page_bookmark' | 'text_highlight' | 'text_note' | 'region_highlight' | 'region_note';
  anchor: Extract<DocumentAnchor, { kind: 'fixed_page' | 'fixed_text' | 'fixed_region' }>;
  quote?: string;
  body?: string;
  color?: string;
  textAnchorRemap?: {
    status: 'remapped' | 'needs_review';
    fromTextRevisionId: string;
    targetTextRevisionId: string;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ListeningPosition {
  id: string;
  bookId: string;
  chapterId: string;
  anchor: DocumentAnchor;
  queueItemFingerprint: string;
  contentRevisionId: string;
  settingsFingerprint: string;
  deviceId: string;
  updatedAt: string;
}

export interface PageDescriptor {
  id: string;
  bookId: string;
  pageIndex: number;
  pageId: string;
  pageHash: string;
  sourceKind: 'pdf_page' | 'archive_image';
  width?: number;
  height?: number;
  rotation?: number;
  assetId?: string;
  archivePath?: string;
  thumbnailAssetId?: string;
  updatedAt: string;
}

export interface DocumentTextRevision {
  id: string;
  bookId: string;
  pageIndex: number;
  pageHash: string;
  source: 'pdf_native' | 'ocr';
  engine: string;
  engineVersion: string;
  language?: string;
  status: 'pending' | 'ready' | 'failed' | 'stale';
  qualityScore?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentTextBlock {
  id: string;
  revisionId: string;
  bookId: string;
  pageIndex: number;
  order: number;
  role: 'heading' | 'paragraph' | 'list_item' | 'caption' | 'footnote' | 'unknown';
  text: string;
  normalizedText: string;
  quads: TextQuad[];
  direction: 'ltr' | 'rtl' | 'ttb';
}

export interface DocumentTextOrderOverride {
  id: string;
  bookId: string;
  pageIndex: number;
  pageHash: string;
  sourceRevisionId: string;
  orderedBlockFingerprints: string[];
  excludedBlockFingerprints: string[];
  createdAt: string;
  updatedAt: string;
}

export type ReaderDocumentBlockKind = 'heading' | 'paragraph' | 'blockquote' | 'list_item' | 'separator' | 'image';

export interface ReaderDocumentInlineMark {
  start: number;
  end: number;
  kind: 'emphasis' | 'strong' | 'link';
  href?: string;
}

export interface ReaderDocumentInlineSemantic {
  start: number;
  end: number;
  kind: 'ruby' | 'language' | 'footnote_reference';
  value?: string;
  relatedBlockId?: string;
}

export type SpokenTextTransform =
  'identity' | 'number' | 'date' | 'time' | 'currency' | 'unit' | 'symbol' | 'ruby' | 'pronunciation';

export interface SpokenTextProjectionSpan {
  spokenStart: number;
  spokenEnd: number;
  sourceStart: number;
  sourceEnd: number;
  transform: SpokenTextTransform;
}

export interface SpokenTextProjection {
  sourceTextHash: string;
  spokenText: string;
  language?: string;
  spans: SpokenTextProjectionSpan[];
  skipped: Array<{ sourceStart: number; sourceEnd: number; ruleId: string }>;
  fingerprint: string;
}

export interface SpokenTextRule {
  id: string;
  scope: 'global' | 'book';
  bookId?: string;
  kind: 'replace_literal' | 'skip_line' | 'skip_prefix' | 'skip_suffix';
  pattern: string;
  replacement?: string;
  enabled: boolean;
  priority: number;
  updatedAt: string;
}

export interface ReaderDocumentSection {
  id: string;
  bookId: string;
  index: number;
  title: string;
  sourceHref?: string;
  blockCount: number;
}

export interface ReaderDocumentBlock {
  id: string;
  bookId: string;
  sectionId: string;
  index: number;
  kind: ReaderDocumentBlockKind;
  plainText: string;
  inlineMarks?: ReaderDocumentInlineMark[];
  inlineSemantics?: ReaderDocumentInlineSemantic[];
  assetId?: string;
  sourceStart?: number;
  sourceEnd?: number;
}

export interface ReaderDocumentBlockPage {
  id: string;
  bookId: string;
  sectionId: string;
  pageIndex: number;
  startBlockIndex: number;
  endBlockIndex: number;
  blocks: ReaderDocumentBlock[];
}

export interface ReaderLayoutKey {
  contentRevisionId: string;
  rendererVersion: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatioBucket: number;
  fontAssetHash: string;
  fontLoadState: 'loaded' | 'fallback';
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  firstLineIndent: number;
  textAlign: string;
  marginX: number;
  marginY: number;
  imageLayoutRevision: string;
}

export interface ReaderPageBoundary {
  index: number;
  start: ReaderAnchor;
  end: ReaderAnchor;
}

export interface ReaderPageMap {
  layoutKeyHash: string;
  sectionId: string;
  boundaries: ReaderPageBoundary[];
  complete: boolean;
  updatedAt: string;
}

export interface ParsedNovel {
  novel: Novel;
  chapters: Chapter[];
  paragraphs: Paragraph[];
}

export interface ParsedNovelImportChapter {
  chapter: Chapter;
  paragraphs: Iterable<Paragraph>;
}

export type ParsedNovelImportChapterSource =
  Iterable<ParsedNovelImportChapter> | AsyncIterable<ParsedNovelImportChapter>;

export interface ParsedNovelImport {
  novel: Novel;
  chapters: Chapter[];
  embeddedAssets?: ParsedNovelImportAsset[];
  consumeChapterParagraphs(): ParsedNovelImportChapterSource;
  consumeEmbeddedAssets?(): AsyncIterable<ParsedNovelImportAsset>;
}

export interface ParsedNovelImportAsset {
  id: string;
  bookId: string;
  kind: 'cover' | 'epub_resource' | 'document_page';
  provenance: 'epub_embedded' | 'archive_embedded';
  fileName: string;
  contentType: string;
  contentHash: string;
  pageIndex?: number;
  bytes: Uint8Array;
}

export interface ReaderSettings {
  id: 'reader-settings';
  theme: ReaderTheme;
  font: ReaderFont;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  marginX: number;
  marginY: number;
  contentWidth: number;
  flow: ReaderFlow;
  /** @deprecated Use ttsPlayback.rate. Kept for older synced clients. */
  ttsSpeed: number;
  ttsVoiceURI?: string;
  ttsPlayback: TTSPlaybackSettings;
  ttsBookOverrides?: Record<string, TTSPlaybackSettingsOverride>;
  readingProfile: ReadingProfile;
  readingBookOverrides?: Record<string, ReadingProfileOverride>;
  gestureBindings: GestureBindings;
  keepScreenChrome: boolean;
}

export type TTSSkippedContentType = 'author_note' | 'system_message' | 'sfx';
export type TTSSleepTimerPreset = 10 | 20 | 30 | 60 | 'end_of_chapter';
export type TTSFootnotePlaybackPolicy = 'skip' | 'immediate' | 'end_of_chapter';

export interface TTSPlaybackSettings {
  schemaVersion: 1;
  rate: number;
  pitch: number;
  volume: number;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  chapterPauseMs: number;
  chapterEndBehavior: 'stop' | 'continue';
  footnotePlayback: TTSFootnotePlaybackPolicy;
  /** Never synthesize or fetch provider audio during playback. Cached native audio may still be used. */
  offlineOnly: boolean;
  sleepTimerDefault?: TTSSleepTimerPreset;
  skippedContentTypes: TTSSkippedContentType[];
}

export type TTSPlaybackSettingsOverride = Partial<Omit<TTSPlaybackSettings, 'schemaVersion' | 'sleepTimerDefault'>> & {
  sleepTimerDefault?: TTSSleepTimerPreset | null;
};

export interface TTSDownloadPolicy {
  network: 'any' | 'unmetered';
  charging: 'any' | 'required';
  retryLimit: number;
  retainUntil: 'manual' | 'completed' | 'space_needed';
}

export interface TTSDownloadJob {
  id: string;
  bookId: string;
  contentRevisionId: string;
  scope: { kind: 'chapter'; chapterIds: string[] } | { kind: 'book' };
  state: 'planned' | 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';
  plannedItems: number;
  readyItems: number;
  failedItems: number;
  byteSize: number;
  estimatedCost?: number;
  policy: TTSDownloadPolicy;
  updatedAt: string;
}

export interface TTSDownloadItem {
  id: string;
  jobId: string;
  bookId: string;
  chapterId: string;
  paragraphId?: string;
  cacheKey: string;
  renderSpecHash: string;
  state: 'planned' | 'running' | 'retry_wait' | 'ready' | 'failed' | 'cancelled';
  byteSize: number;
  attempts: number;
  errorMessage?: string;
  nextAttemptAt?: string;
  updatedAt: string;
}

export interface TTSOfflineCacheManifestEntry {
  id: string;
  bookId: string;
  chapterId: string;
  cacheKey: string;
  renderSpecHash: string;
  contentRevisionId: string;
  byteSize: number;
  storage: 'native' | 'indexeddb';
  pinnedByJobIds: string[];
  createdAt: string;
  lastAccessedAt: string;
}

export interface ComicReadingProfile {
  schemaVersion: 1;
  mode: 'single' | 'spread' | 'vertical';
  direction: 'ltr' | 'rtl';
  coverBehavior: 'single' | 'paired';
  pageParity: 'auto' | 'left' | 'right';
  fit: 'page' | 'width' | 'height' | 'original';
  crop: 'off' | 'auto' | 'manual';
  brightness: number;
  contrast: number;
  saturation: number;
  grayscale: boolean;
  invert: boolean;
  manualCrop?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  pageCrops?: Record<
    string,
    {
      top: number;
      right: number;
      bottom: number;
      left: number;
    }
  >;
  gap?: number;
  background?: 'black' | 'charcoal' | 'white';
}

export interface Bookmark {
  id: string;
  novelId: string;
  chapterId: string;
  paragraphId?: string;
  label: string;
  progress: number;
  scrollTop: number;
  createdAt: string;
}

export interface ReaderNote {
  id: string;
  novelId: string;
  chapterId: string;
  paragraphId?: string;
  quote?: string;
  body: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReaderHighlight {
  id: string;
  novelId: string;
  chapterId: string;
  paragraphId: string;
  quote: string;
  color: 'yellow' | 'green' | 'blue' | 'pink';
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface Character {
  id: string;
  novelId: string;
  canonicalName: string;
  aliases: string[];
  color: string;
  description?: string;
  confidence: number;
  isUserConfirmed: boolean;
}

export interface VoiceProfile {
  id: string;
  novelId: string;
  characterId?: string;
  role: 'narrator' | 'character' | 'system' | 'unknown';
  providerId: string;
  providerVoiceId: string;
  providerModel?: string;
  label: string;
  language?: string;
  tone?: string;
  speed: number;
  pitch?: number;
  emotionPolicy?: string;
  providerOptions?: Record<string, unknown>;
  isUserSelected: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface LabeledSegment {
  id: string;
  novelId: string;
  chapterId: string;
  paragraphId: string;
  segmentIndex: number;
  startOffset: number;
  endOffset: number;
  segmentTextHash: string;
  type: SegmentType;
  speakerId: 'narrator' | 'system' | 'unknown' | string;
  candidateSpeakers: string[];
  listenerIds: string[];
  emotion: string;
  prosodyIntent?: {
    pace?: string;
    intensity?: string;
    delivery?: string;
  };
  confidence: number;
  evidence?: string;
  voiceProfileId?: string;
  isUserCorrected: boolean;
}

export interface UserCorrection {
  id: string;
  novelId: string;
  chapterId: string;
  paragraphId?: string;
  segmentId?: string;
  correctionType: 'speaker' | 'listener' | 'emotion' | 'prosody' | 'segment_type' | 'voice' | 'note';
  beforeJson?: string;
  afterJson: string;
  applyScope: 'segment' | 'chapter' | 'future_pattern' | 'global';
  operationId?: string;
  intentKind?: 'segment_only' | 'relabel_from_window' | 'reference_mapping';
  intentJson?: string;
  provenanceKind?: 'user_label_mutation' | 'review_approved_generated';
  sourceReviewArtifactId?: string;
  createdAt: string;
}
