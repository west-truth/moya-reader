import { projectSpokenText } from '@noveldesk/text-core/spoken-text';
import type { Chapter, ParagraphPage, SpokenTextRule } from '../../domain/types';

export interface SpokenTextRuleImpactSample {
  readonly chapterTitle: string;
  readonly paragraphIndex: number;
  readonly source: string;
}

export interface SpokenTextRuleImpactSummary {
  readonly scannedParagraphCount: number;
  readonly affectedParagraphCount: number;
  readonly fullySkippedParagraphCount: number;
  readonly skippedRangeCount: number;
  readonly samples: readonly SpokenTextRuleImpactSample[];
}

export interface InspectSpokenTextRuleImpactInput {
  readonly chapters: readonly Chapter[];
  readonly language?: string;
  readonly rules: readonly SpokenTextRule[];
  readonly signal: AbortSignal;
  readonly iterateParagraphPages: (chapterId: string, signal: AbortSignal) => AsyncIterable<ParagraphPage>;
  readonly sampleLimit?: number;
  readonly sampleCharacterLimit?: number;
}

function sampleText(source: string, limit: number): string {
  const normalized = source.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export async function inspectSpokenTextRuleImpact(
  input: InspectSpokenTextRuleImpactInput,
): Promise<SpokenTextRuleImpactSummary> {
  const skipRuleIds = new Set(
    input.rules
      .filter((rule) => rule.enabled && rule.kind !== 'replace_literal' && rule.pattern.trim())
      .map((rule) => rule.id),
  );
  const sampleLimit = Math.max(0, Math.trunc(input.sampleLimit ?? 3));
  const sampleCharacterLimit = Math.max(24, Math.trunc(input.sampleCharacterLimit ?? 120));
  let scannedParagraphCount = 0;
  let affectedParagraphCount = 0;
  let fullySkippedParagraphCount = 0;
  let skippedRangeCount = 0;
  const samples: SpokenTextRuleImpactSample[] = [];

  for (const chapter of [...input.chapters].sort((left, right) => left.index - right.index)) {
    for await (const page of input.iterateParagraphPages(chapter.id, input.signal)) {
      input.signal.throwIfAborted();
      for (const paragraph of page.paragraphs) {
        input.signal.throwIfAborted();
        scannedParagraphCount += 1;
        const projection = projectSpokenText({
          text: paragraph.text,
          language: input.language,
          semantics: paragraph.inlineSemantics,
          rules: input.rules,
          rubyPolicy: 'reading',
          footnotePolicy: 'skip_marker',
        });
        const matchingSkipped = projection.skipped.filter((range) => skipRuleIds.has(range.ruleId));
        if (matchingSkipped.length === 0) continue;
        affectedParagraphCount += 1;
        skippedRangeCount += matchingSkipped.length;
        if (!projection.spokenText.trim()) fullySkippedParagraphCount += 1;
        if (samples.length < sampleLimit) {
          samples.push({
            chapterTitle: chapter.title,
            paragraphIndex: paragraph.index,
            source: sampleText(paragraph.text, sampleCharacterLimit),
          });
        }
      }
    }
  }

  return {
    scannedParagraphCount,
    affectedParagraphCount,
    fullySkippedParagraphCount,
    skippedRangeCount,
    samples,
  };
}
