import { normalizeSerialWorkKey, parseSerialReleaseName, type SerialReleaseName } from './serial-release-name';

export interface WorkTitleExtraction {
  readonly originalTitle: string;
  readonly canonicalTitle: string;
  readonly queryCandidates: readonly string[];
  readonly parsed: SerialReleaseName;
  readonly confidence: SerialReleaseName['confidence'];
  readonly evidence: readonly string[];
}

function normalizedCandidateKey(value: string): string {
  return normalizeSerialWorkKey(value).replace(/[\p{P}\p{S}\s]+/gu, '');
}

function addCandidate(candidates: string[], seen: Set<string>, value: string | undefined): void {
  const candidate = value?.trim().replace(/\s+/gu, ' ');
  if (!candidate) return;
  const key = normalizedCandidateKey(candidate);
  if (!key || seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

/**
 * Extracts lookup candidates without changing the title stored in the library.
 * Conservative candidates come first; the original title remains a final fallback.
 */
export function extractWorkTitle(title: string, sourceFileName?: string): WorkTitleExtraction {
  const originalTitle = title.trim().replace(/\s+/gu, ' ');
  const parsed = parseSerialReleaseName(originalTitle);
  const sourceParsed = sourceFileName ? parseSerialReleaseName(sourceFileName, parsed.workTitle) : undefined;
  const candidates: string[] = [];
  const seen = new Set<string>();

  addCandidate(candidates, seen, parsed.workTitle);
  addCandidate(candidates, seen, sourceParsed?.workTitle);
  addCandidate(candidates, seen, originalTitle);

  const canonicalTitle = candidates[0] ?? originalTitle;
  const evidence = [...parsed.evidence];
  if (sourceParsed && sourceParsed.workTitle !== sourceParsed.displayBaseName) {
    evidence.push('source_filename_cleanup');
  }
  if (canonicalTitle !== originalTitle && !evidence.includes('title_cleanup')) evidence.push('title_cleanup');

  return {
    originalTitle,
    canonicalTitle,
    queryCandidates: candidates,
    parsed,
    confidence: parsed.confidence,
    evidence,
  };
}
