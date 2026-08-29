import type { ChapterSplitMode } from '@noveldesk/contracts';
import type { HeadingMatch } from './contracts';
import { parseChapterHeading } from './heading-detector';

const minBodyCharsForWeakSequence = 40;

interface ScannedLine {
  lineIndex: number;
  lineText: string;
  lineStart: number;
  hasBlankBefore: boolean;
  hasBlankAfter: boolean;
}

interface ResolveHeadingOptions {
  mode: ChapterSplitMode;
}

function sequenceFamily(family: string): string {
  return family.replace(/^angle_/, '');
}

function bodyLengthInRun(text: string, heading: HeadingMatch, index: number, run: HeadingMatch[]): number {
  const nextStart = run[index + 1]?.lineStart ?? text.length;
  return text.slice(heading.contentStart, nextStart).trim().length;
}

function bodyLengthUntilNextCandidate(text: string, heading: HeadingMatch, orderedCandidates: HeadingMatch[]): number {
  const index = orderedCandidates.indexOf(heading);
  const nextStart = index >= 0 ? (orderedCandidates[index + 1]?.lineStart ?? text.length) : text.length;
  return text.slice(heading.contentStart, nextStart).trim().length;
}

function hasWeakHeadingTitleSignal(candidate: HeadingMatch): boolean {
  return !['bracket_number', 'brace_number', 'number_only'].includes(sequenceFamily(candidate.family));
}

function isWeakCandidateEligible(candidate: HeadingMatch): boolean {
  if (candidate.number === undefined) return false;
  if (!candidate.hasBlankBefore) return false;

  const family = sequenceFamily(candidate.family);
  if (family === 'bracket_number') {
    return (
      candidate.hasBlankAfter && /^(?:\[|【|〔|「|『)\s*\d{1,5}\s*(?:\]|】|〕|」|』)$/.test(candidate.lineText.trim())
    );
  }

  if (family === 'brace_number' || family === 'number_only') {
    return candidate.hasBlankAfter;
  }

  return candidate.hasBlankAfter || hasWeakHeadingTitleSignal(candidate);
}

function collectValidWeakRuns(text: string, group: HeadingMatch[]): HeadingMatch[] {
  const eligible = group.filter(isWeakCandidateEligible).sort((left, right) => left.lineStart - right.lineStart);
  const accepted: HeadingMatch[] = [];

  const flushRun = (run: HeadingMatch[]) => {
    if (run.length < 2) return;
    const hasEnoughBody = run.every((heading, index) => {
      return bodyLengthInRun(text, heading, index, run) >= minBodyCharsForWeakSequence;
    });
    if (hasEnoughBody) accepted.push(...run);
  };

  let run: HeadingMatch[] = [];
  for (const candidate of eligible) {
    const previous = run[run.length - 1];
    if (!previous || candidate.number === (previous.number ?? 0) + 1) {
      run.push(candidate);
      continue;
    }
    flushRun(run);
    run = [candidate];
  }
  flushRun(run);

  return accepted;
}

function collectValidMixedWeakRuns(text: string, candidates: HeadingMatch[]): HeadingMatch[] {
  const orderedCandidates = [...candidates].sort((left, right) => left.lineStart - right.lineStart);
  const eligible = orderedCandidates.filter(
    (candidate) => candidate.requiresSequence && isWeakCandidateEligible(candidate),
  );
  const accepted: HeadingMatch[] = [];

  const flushRun = (run: HeadingMatch[]) => {
    if (run.length < 2) return;
    const hasEnoughBody = run.every((heading) => {
      return bodyLengthUntilNextCandidate(text, heading, orderedCandidates) >= minBodyCharsForWeakSequence;
    });
    if (hasEnoughBody) accepted.push(...run);
  };

  let run: HeadingMatch[] = [];
  for (const candidate of eligible) {
    const previous = run[run.length - 1];
    if (!previous || candidate.number === (previous.number ?? 0) + 1) {
      run.push(candidate);
      continue;
    }
    flushRun(run);
    run = [candidate];
  }
  flushRun(run);

  return accepted;
}

function isHighRiskWeakFamily(family: string): boolean {
  return ['bracket_number', 'brace_number', 'dot_episode', 'paren_episode', 'number_only'].includes(
    sequenceFamily(family),
  );
}

function collectLowRiskMixedWeakRuns(text: string, candidates: HeadingMatch[]): HeadingMatch[] {
  return collectValidMixedWeakRuns(
    text,
    candidates.filter((candidate) => !isHighRiskWeakFamily(candidate.family)),
  );
}

function collectProducerSwitchWeakRuns(
  text: string,
  candidates: HeadingMatch[],
  accepted: Set<HeadingMatch>,
): HeadingMatch[] {
  const orderedCandidates = [...candidates].sort((left, right) => left.lineStart - right.lineStart);
  const workingAccepted = new Set(accepted);
  const newlyAccepted: HeadingMatch[] = [];

  for (let index = 0; index < orderedCandidates.length; index += 1) {
    const first = orderedCandidates[index];
    if (
      workingAccepted.has(first) ||
      !first.requiresSequence ||
      !isWeakCandidateEligible(first) ||
      first.number === undefined
    ) {
      continue;
    }

    const previousAccepted = [...orderedCandidates]
      .reverse()
      .find(
        (heading) =>
          workingAccepted.has(heading) && heading.number !== undefined && heading.lineStart < first.lineStart,
      );
    if (!previousAccepted || first.number !== (previousAccepted.number ?? 0) + 1) continue;

    const run: HeadingMatch[] = [];
    let expectedNumber = first.number;
    for (let runIndex = index; runIndex < orderedCandidates.length; runIndex += 1) {
      const candidate = orderedCandidates[runIndex];
      if (workingAccepted.has(candidate)) break;
      if (
        !candidate.requiresSequence ||
        !isWeakCandidateEligible(candidate) ||
        candidate.number === undefined ||
        candidate.number !== expectedNumber
      ) {
        break;
      }
      run.push(candidate);
      expectedNumber += 1;
    }

    const switchedFamilies = new Set(run.map((candidate) => sequenceFamily(candidate.family)));
    const hasEnoughBody = run.every((heading) => {
      return bodyLengthUntilNextCandidate(text, heading, orderedCandidates) >= minBodyCharsForWeakSequence;
    });
    if (
      run.length < 2 ||
      switchedFamilies.size < 2 ||
      !run.some((candidate) => isHighRiskWeakFamily(candidate.family)) ||
      !run.some(hasWeakHeadingTitleSignal) ||
      !hasEnoughBody
    ) {
      continue;
    }

    for (const candidate of run) {
      if (workingAccepted.has(candidate)) continue;
      workingAccepted.add(candidate);
      newlyAccepted.push(candidate);
    }
    index += run.length - 1;
  }

  return newlyAccepted;
}

function collectAnchoredMixedWeakHeadings(
  text: string,
  candidates: HeadingMatch[],
  accepted: Set<HeadingMatch>,
  options: { allowTrailingHighRisk?: boolean; allowUntitledTrailingHighRisk?: boolean } = {},
): HeadingMatch[] {
  const orderedCandidates = [...candidates].sort((left, right) => left.lineStart - right.lineStart);
  const acceptedHeadings = orderedCandidates.filter(
    (candidate) => accepted.has(candidate) && candidate.number !== undefined,
  );
  const anchored: HeadingMatch[] = [];

  for (const candidate of orderedCandidates) {
    if (
      !candidate.requiresSequence ||
      accepted.has(candidate) ||
      !isWeakCandidateEligible(candidate) ||
      candidate.number === undefined
    ) {
      continue;
    }
    if (bodyLengthUntilNextCandidate(text, candidate, orderedCandidates) < minBodyCharsForWeakSequence) continue;

    const previousAccepted = [...acceptedHeadings].reverse().find((heading) => heading.lineStart < candidate.lineStart);
    const nextAccepted = acceptedHeadings.find((heading) => heading.lineStart > candidate.lineStart);
    const followsPrevious = previousAccepted?.number !== undefined && candidate.number === previousAccepted.number + 1;
    const precedesNext = nextAccepted?.number !== undefined && nextAccepted.number === candidate.number + 1;
    const stronglyAnchored = followsPrevious && precedesNext;
    const highRiskFamily = isHighRiskWeakFamily(candidate.family);
    const trailingHighRiskSwitch =
      Boolean(options.allowTrailingHighRisk) &&
      followsPrevious &&
      !precedesNext &&
      highRiskFamily &&
      (hasWeakHeadingTitleSignal(candidate) || Boolean(options.allowUntitledTrailingHighRisk));

    if (stronglyAnchored || (!highRiskFamily && (followsPrevious || precedesNext)) || trailingHighRiskSwitch) {
      anchored.push(candidate);
    }
  }

  return anchored;
}

function collectAnchoredWeakHeadingsUntilStable(
  text: string,
  candidates: HeadingMatch[],
  accepted: Set<HeadingMatch>,
  options: { allowTrailingHighRisk?: boolean; allowUntitledTrailingHighRisk?: boolean } = {},
): HeadingMatch[] {
  const anchored: HeadingMatch[] = [];
  let changed: boolean;
  do {
    changed = false;
    for (const candidate of collectAnchoredMixedWeakHeadings(text, candidates, accepted, options)) {
      if (accepted.has(candidate)) continue;
      accepted.add(candidate);
      anchored.push(candidate);
      changed = true;
    }
  } while (changed);

  return anchored;
}

function nextLineEnd(text: string, start: number): number {
  const next = text.indexOf('\n', start);
  return next >= 0 ? next : text.length;
}

function* scanLines(text: string): Generator<ScannedLine> {
  let lineIndex = 0;
  let lineStart = 0;
  let previousBlank = true;

  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf('\n', lineStart);
    const lineEnd = newlineIndex >= 0 ? newlineIndex : text.length;
    const lineText = text.slice(lineStart, lineEnd);
    const nextLineStart = newlineIndex >= 0 ? newlineIndex + 1 : text.length;
    const hasNextLine = newlineIndex >= 0;
    const nextLineBlank = hasNextLine
      ? text.slice(nextLineStart, nextLineEnd(text, nextLineStart)).trim() === ''
      : true;

    yield {
      lineIndex,
      lineText,
      lineStart,
      hasBlankBefore: lineIndex === 0 || previousBlank,
      hasBlankAfter: !hasNextLine || nextLineBlank,
    };

    previousBlank = lineText.trim() === '';
    if (!hasNextLine) break;
    lineStart = nextLineStart;
    lineIndex += 1;
  }
}

const explicitEpisodeUnit =
  /(?:\d{1,5}|[영공일이삼사오육칠팔구십백천만零〇一二三四五六七八九十百千万萬两兩]+)\s*(?:화|話|话|회|回)(?:\s|$|[.:：\-–—_「『《〈(（[【])/i;

function suppressWeakHeadingsNestedInExplicitEpisodes(
  candidates: readonly HeadingMatch[],
  accepted: Set<HeadingMatch>,
): void {
  const explicitEpisodes = candidates
    .filter(
      (candidate) =>
        accepted.has(candidate) &&
        !candidate.requiresSequence &&
        candidate.number !== undefined &&
        explicitEpisodeUnit.test(candidate.title),
    )
    .sort((left, right) => left.lineStart - right.lineStart);

  for (let index = 0; index < explicitEpisodes.length - 1; index += 1) {
    const current = explicitEpisodes[index]!;
    const next = explicitEpisodes[index + 1]!;
    if (sequenceFamily(current.family) !== sequenceFamily(next.family) || next.number !== current.number! + 1) continue;

    for (const candidate of candidates) {
      if (
        candidate.requiresSequence &&
        candidate.lineStart > current.lineStart &&
        candidate.lineStart < next.lineStart
      ) {
        accepted.delete(candidate);
      }
    }
  }
}

export function resolveChapterHeadings(
  text: string,
  options: ResolveHeadingOptions = { mode: 'auto' },
): HeadingMatch[] {
  if (options.mode === 'single') return [];

  const candidates: HeadingMatch[] = [];
  for (const line of scanLines(text)) {
    const heading = parseChapterHeading(line.lineText);
    if (heading) {
      candidates.push({
        title: heading.title,
        family: heading.family,
        number: heading.number,
        requiresSequence: heading.requiresSequence,
        lineIndex: line.lineIndex,
        lineText: line.lineText,
        hasBlankBefore: line.hasBlankBefore,
        hasBlankAfter: line.hasBlankAfter,
        lineStart: line.lineStart,
        contentStart: Math.min(line.lineStart + line.lineText.length + 1, text.length),
      });
    }
  }

  const accepted = new Set<HeadingMatch>();
  for (const candidate of candidates) {
    if (!candidate.requiresSequence) accepted.add(candidate);
  }

  const weakGroups = new Map<string, HeadingMatch[]>();
  for (const candidate of candidates) {
    if (!candidate.requiresSequence) continue;
    const family = sequenceFamily(candidate.family);
    weakGroups.set(family, [...(weakGroups.get(family) ?? []), candidate]);
  }

  for (const group of weakGroups.values()) {
    collectValidWeakRuns(text, group).forEach((candidate) => accepted.add(candidate));
  }

  if (options.mode === 'auto') {
    collectLowRiskMixedWeakRuns(text, candidates).forEach((candidate) => accepted.add(candidate));
    collectProducerSwitchWeakRuns(text, candidates, accepted).forEach((candidate) => accepted.add(candidate));
    collectAnchoredWeakHeadingsUntilStable(text, candidates, accepted);
  }

  if (options.mode === 'mixed') {
    collectValidMixedWeakRuns(text, candidates).forEach((candidate) => accepted.add(candidate));
    collectAnchoredWeakHeadingsUntilStable(text, candidates, accepted, {
      allowTrailingHighRisk: true,
      allowUntitledTrailingHighRisk: true,
    });
  }

  suppressWeakHeadingsNestedInExplicitEpisodes(candidates, accepted);

  return candidates.filter((candidate) => accepted.has(candidate));
}
