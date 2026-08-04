import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Chapter, Character, Paragraph } from '../src/domain/types';
import { hashSync } from '@noveldesk/text-core/legacy-hash';
import { DesktopStructuredJsonAIProvider } from '../src/providers/desktop-structured-json-provider';
import { STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID } from '../src/providers/chapter-labeling-request-profile';
import { validateChapterLabelingResult } from '../src/providers/chapter-labeling-validator';
import { createGeminiVertexGenerateContentClient } from '../apps/server/src/providers/gemini-vertex-ai-provider';
import { loadServerAISettings, modelIdForProvider } from '../apps/server/src/providers/server-ai-config';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');
const live = process.argv.includes('--live');

if (!live) {
  console.log(
    JSON.stringify(
      {
        live: false,
        skipped: true,
        message: '--live를 붙이면 데스크톱 라벨링 계약을 통해 Gemini Vertex 요청 1회를 실행합니다.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const smokeEnv = {
  ...process.env,
  VERTEX_CREDENTIALS_DIR: process.env.VERTEX_CREDENTIALS_DIR || path.join(workspaceRoot, 'vertex env'),
  GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || process.env.NOVELDESK_DESKTOP_VERTEX_LOCATION || 'global',
  AI_PROVIDER_ENABLED: process.env.AI_PROVIDER_ENABLED || 'mock,gemini-vertex',
  AI_PROVIDER_DEFAULT: process.env.AI_PROVIDER_DEFAULT || 'gemini-vertex',
  AI_GEMINI_VERTEX_LABELING_MODEL_ID:
    process.env.AI_GEMINI_VERTEX_LABELING_MODEL_ID ||
    process.env.NOVELDESK_DESKTOP_VERTEX_MODEL ||
    'gemini-3.1-flash-lite',
};

const settings = loadServerAISettings(smokeEnv, workspaceRoot);
const modelId = modelIdForProvider(settings, 'gemini-vertex') || 'gemini-3.1-flash-lite';

if (!settings.secretConfiguredByProvider['gemini-vertex']) {
  throw new Error(
    'Gemini Vertex credential이 설정되지 않았습니다. GOOGLE_APPLICATION_CREDENTIALS 또는 VERTEX_CREDENTIALS_DIR를 설정하세요.',
  );
}
if (!settings.geminiVertex.project?.trim()) {
  throw new Error('Gemini Vertex project가 설정되지 않았습니다.');
}
if (!settings.geminiVertex.credentialsPath?.trim()) {
  throw new Error('Gemini Vertex credential path가 설정되지 않았습니다.');
}

const now = '2026-07-06T00:00:00.000Z';
const paragraphTexts = ['"여긴 어디지?" 민아가 낮게 속삭였다.', '[시스템] 새로운 퀘스트가 도착했습니다.'];
let offset = 0;
const paragraphs: Paragraph[] = paragraphTexts.map((text, index) => {
  const start = offset;
  const end = start + text.length;
  offset = end + 2;
  return {
    id: `paragraph_vertex_contract_${index + 1}`,
    novelId: 'book_vertex_contract',
    chapterId: 'chapter_vertex_contract_1',
    index,
    text,
    startOffsetInChapter: start,
    endOffsetInChapter: end,
    textHash: hashSync(text),
  };
});

const normalizedText = paragraphTexts.join('\n\n');
const chapter: Chapter = {
  id: 'chapter_vertex_contract_1',
  novelId: 'book_vertex_contract',
  index: 1,
  title: 'Vertex contract smoke',
  normalizedText,
  textHash: hashSync(normalizedText),
  rawStartOffset: 0,
  rawEndOffset: normalizedText.length,
  characterCount: normalizedText.length,
  paragraphCount: paragraphs.length,
  createdAt: now,
  updatedAt: now,
};
const knownCharacters: Character[] = [
  {
    id: 'char_mina',
    novelId: chapter.novelId,
    canonicalName: '민아',
    aliases: ['Mina'],
    color: '#3b82f6',
    description: 'The speaker in the opening dialogue.',
    confidence: 0.95,
    isUserConfirmed: true,
  },
];

const client = await createGeminiVertexGenerateContentClient({
  project: settings.geminiVertex.project,
  location: settings.geminiVertex.location,
  credentialsPath: settings.geminiVertex.credentialsPath,
});
const provider = new DesktopStructuredJsonAIProvider({
  providerId: 'gemini-vertex',
  displayName: 'Gemini Vertex',
  modelId,
  providerOptions: {
    requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
    temperature: 0.1,
    maxOutputTokens: 4096,
  },
  generateJson: (input) =>
    client.generateJson({
      modelId: input.modelId,
      prompt: input.prompt,
      responseSchema: input.responseSchema,
      providerOptions: input.providerOptions,
    }),
});

const result = await provider.labelChapterSegments({
  novelId: chapter.novelId,
  chapter,
  paragraphs,
  knownCharacters,
});
const validation = validateChapterLabelingResult({
  novelId: chapter.novelId,
  chapter,
  paragraphs,
  knownCharacters,
  result,
});

if (!validation.ok) {
  throw new Error(`데스크톱 Vertex 라벨링 계약 검증 실패: ${validation.summary.issueCodes.join(', ')}`);
}

const segmentTypes = result.segments.reduce<Record<string, number>>((acc, segment) => {
  acc[segment.type] = (acc[segment.type] ?? 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      live: true,
      providerId: 'gemini-vertex',
      modelId,
      requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
      paragraphCount: paragraphs.length,
      segmentCount: result.segments.length,
      segmentTypes,
      validation: validation.summary,
      hasEpisodeContextSummary: Boolean(
        result.episodeContextSummary?.summaryForNextChapter || result.episodeContextSummary?.scene,
      ),
    },
    null,
    2,
  ),
);
