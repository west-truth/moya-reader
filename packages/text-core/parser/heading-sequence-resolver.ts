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

interface StructuralSeparator {
  marker: string;
  lineIndex: number;
  lineText: string;
  lineStart: number;
  contentStart: number;
  hasBlankBefore: boolean;
  hasBlankAfter: boolean;
}

interface ResolveHeadingOptions {
  mode: ChapterSplitMode;
}

function sequenceFamily(family: string): string {
  return family.replace(/^angle_/, '');
}

function normalizeHeadingIdentity(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.!?…。．]+$/u, '');
}

function producerFamily(family: string): string {
  if (family.startsWith('angle_')) return 'angle';
  return sequenceFamily(family);
}

function trimmedRangeLength(text: string, start: number, end: number): number {
  let first = start;
  while (first < end && text[first]!.trim() === '') first += 1;

  let last = end;
  while (last > first && text[last - 1]!.trim() === '') last -= 1;
  return last - first;
}

function bodyLengthInRun(text: string, heading: HeadingMatch, index: number, run: readonly HeadingMatch[]): number {
  const nextStart = run[index + 1]?.lineStart ?? text.length;
  return trimmedRangeLength(text, heading.contentStart, nextStart);
}

function tinyChapterThreshold(bodyLengths: readonly number[]): number {
  const positive = bodyLengths.filter((length) => length > 0).sort((left, right) => left - right);
  if (positive.length < 2) return 0;

  const median = positive[Math.floor(positive.length / 2)]!;
  if (median < 400) return 0;
  return Math.min(160, Math.max(minBodyCharsForWeakSequence, Math.floor(median * 0.03)));
}

function earlierHeadingOwnsLaterTitle(current: HeadingMatch, next: HeadingMatch): boolean {
  const currentIdentity = normalizeHeadingIdentity(current.title);
  const nextIdentity = normalizeHeadingIdentity(next.title);
  return currentIdentity === nextIdentity || (nextIdentity.length >= 3 && currentIdentity.includes(nextIdentity));
}

function serializedPartIdentity(title: string): { base: string; part: number } | undefined {
  const match = title.trim().match(/^(.*?)\s*[（(]\s*(\d{1,5})\s*[)）]\s*$/u);
  if (!match) return undefined;
  return {
    base: normalizeHeadingIdentity(match[1]!),
    part: Number.parseInt(match[2]!, 10),
  };
}

function hasCoherentSerializedRun(headings: readonly HeadingMatch[]): boolean {
  if (headings.length < 3) return false;
  const ordered = [...headings].sort((left, right) => left.lineStart - right.lineStart);
  let coherentTransitions = 0;

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = serializedPartIdentity(ordered[index]!.title);
    const next = serializedPartIdentity(ordered[index + 1]!.title);
    if (current && next && current.base === next.base && next.part === current.part + 1) {
      coherentTransitions += 1;
    }
  }

  return coherentTransitions >= 2 && coherentTransitions / (ordered.length - 1) >= 0.6;
}

function hasCoherentNumberedRun(headings: readonly HeadingMatch[]): boolean {
  if (headings.length < 3) return false;
  const ordered = [...headings].sort((left, right) => left.lineStart - right.lineStart);
  let coherentTransitions = 0;

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index]!.number;
    const next = ordered[index + 1]!.number;
    if (current !== undefined && next === current + 1) coherentTransitions += 1;
  }

  return coherentTransitions >= 2 && coherentTransitions / (ordered.length - 1) >= 0.6;
}

function suppressTinyChapterBoundaries(text: string, candidates: readonly HeadingMatch[], accepted: Set<HeadingMatch>) {
  while (true) {
    const headings = candidates.filter((candidate) => accepted.has(candidate));
    if (headings.length === 0) return;
    if (headings.length === 1) {
      if (bodyLengthInRun(text, headings[0]!, 0, headings) === 0) accepted.delete(headings[0]!);
      return;
    }

    const bodyLengths = headings.map((heading, index) => bodyLengthInRun(text, heading, index, headings));
    const threshold = tinyChapterThreshold(bodyLengths);
    const positive = bodyLengths.filter((length) => length > 0).sort((left, right) => left - right);
    const median = positive[Math.floor(positive.length / 2)] ?? 0;
    const duplicateTailThreshold = Math.min(1_200, Math.max(threshold, Math.floor(median * 0.2)));
    const removals = new Set<HeadingMatch>();

    for (let index = 0; index < headings.length; index += 1) {
      const current = headings[index]!;
      const previous = headings[index - 1];
      if (
        previous &&
        normalizeHeadingIdentity(previous.title) === normalizeHeadingIdentity(current.title) &&
        bodyLengths[index]! <= duplicateTailThreshold
      ) {
        removals.add(current);
        continue;
      }
      if (removals.has(current) || bodyLengths[index]! > threshold) continue;

      const next = headings[index + 1];
      const decoratedCurrentOwnsAdjacentPlain =
        next && producerFamily(current.family) === 'angle' && producerFamily(next.family) !== 'angle';
      if (
        next &&
        !removals.has(next) &&
        (earlierHeadingOwnsLaterTitle(current, next) || decoratedCurrentOwnsAdjacentPlain)
      ) {
        removals.add(next);
      } else {
        removals.add(current);
      }
    }

    if (removals.size === 0) return;
    removals.forEach((heading) => accepted.delete(heading));
  }
}

function structuralSeparatorMarker(line: string): string | undefined {
  const match = line.trim().match(/^([=_~\-–—])\1{2,79}$/u);
  return match?.[1];
}

function medianValue(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function collectStructuralSeparatorHeadings(
  text: string,
  separators: readonly StructuralSeparator[],
  detectedHeadings: readonly HeadingMatch[],
): { headings: HeadingMatch[]; absorbed: Set<HeadingMatch> } {
  const groups = new Map<string, StructuralSeparator[]>();
  for (const separator of separators) {
    groups.set(separator.marker, [...(groups.get(separator.marker) ?? []), separator]);
  }

  const headings: HeadingMatch[] = [];
  const absorbed = new Set<HeadingMatch>();

  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.lineStart - right.lineStart);
    if (ordered.length < 3) continue;

    const intervalLengths = ordered
      .slice(0, -1)
      .map((separator, index) => trimmedRangeLength(text, separator.contentStart, ordered[index + 1]!.lineStart));
    const typicalLength = medianValue(intervalLengths);
    const substantiveIntervals = intervalLengths.filter(
      (length) => length >= Math.max(400, Math.floor(typicalLength * 0.15)),
    ).length;
    const isolatedSeparators = ordered.filter(
      (separator) => separator.hasBlankBefore && separator.hasBlankAfter,
    ).length;
    const trailingLength = trimmedRangeLength(text, ordered.at(-1)!.contentStart, text.length);

    if (
      typicalLength < 1_200 ||
      substantiveIntervals / intervalLengths.length < 0.8 ||
      isolatedSeparators / ordered.length < 0.8
    ) {
      continue;
    }

    const activeSeparators = trailingLength >= 400 ? ordered : ordered.slice(0, -1);
    const firstSeparator = ordered[0]!;
    const hasExplicitPrefixHeading = detectedHeadings.some(
      (candidate) => !candidate.requiresSequence && candidate.lineStart < firstSeparator.lineStart,
    );
    if (
      !hasExplicitPrefixHeading &&
      trimmedRangeLength(text, 0, firstSeparator.lineStart) >= 400 &&
      activeSeparators.length > 0
    ) {
      headings.push({
        title: '',
        family: 'structural_separator',
        requiresSequence: false,
        lineIndex: 0,
        lineText: '',
        hasBlankBefore: true,
        hasBlankAfter: true,
        lineStart: 0,
        contentStart: 0,
      });
    }

    for (let index = 0; index < activeSeparators.length; index += 1) {
      const separator = activeSeparators[index]!;
      const nextSeparatorStart = activeSeparators[index + 1]?.lineStart ?? text.length;
      const immediateHeading = detectedHeadings.find(
        (candidate) =>
          !candidate.requiresSequence &&
          candidate.lineStart > separator.lineStart &&
          candidate.lineStart < nextSeparatorStart &&
          trimmedRangeLength(text, separator.contentStart, candidate.lineStart) === 0,
      );

      if (immediateHeading) absorbed.add(immediateHeading);
      headings.push({
        title: immediateHeading?.title ?? '',
        family: 'structural_separator',
        number: immediateHeading?.number,
        requiresSequence: false,
        lineIndex: separator.lineIndex,
        lineText: separator.lineText,
        hasBlankBefore: separator.hasBlankBefore,
        hasBlankAfter: separator.hasBlankAfter,
        lineStart: separator.lineStart,
        contentStart: immediateHeading?.contentStart ?? separator.contentStart,
      });
    }
  }

  headings.sort((left, right) => left.lineStart - right.lineStart);
  return { headings, absorbed };
}

function suppressHeadingsInsideStructuralSegments(
  text: string,
  candidates: readonly HeadingMatch[],
  structuralHeadings: readonly HeadingMatch[],
  accepted: Set<HeadingMatch>,
): void {
  for (let index = 0; index < structuralHeadings.length; index += 1) {
    const current = structuralHeadings[index]!;
    const end = structuralHeadings[index + 1]?.lineStart ?? text.length;
    for (const candidate of candidates) {
      if (candidate === current || candidate.family === 'structural_separator') continue;
      if (candidate.lineStart > current.lineStart && candidate.lineStart < end) accepted.delete(candidate);
    }
  }
}

function suppressHeadingsNestedInDominantProducer(
  candidates: readonly HeadingMatch[],
  accepted: Set<HeadingMatch>,
): void {
  const acceptedNonStructural = candidates.filter(
    (candidate) => accepted.has(candidate) && candidate.family !== 'structural_separator',
  );
  const groups = new Map<string, HeadingMatch[]>();
  for (const candidate of acceptedNonStructural) {
    const producer = producerFamily(candidate.family);
    groups.set(producer, [...(groups.get(producer) ?? []), candidate]);
  }

  const dominant = [...groups.entries()]
    .filter(
      ([, headings]) =>
        hasCoherentSerializedRun(headings) ||
        hasCoherentNumberedRun(headings) ||
        (headings.length >= 12 && headings.length / acceptedNonStructural.length >= 0.65),
    )
    .sort(
      (left, right) =>
        right[1].length - left[1].length ||
        Math.min(...left[1].map((heading) => heading.lineStart)) -
          Math.min(...right[1].map((heading) => heading.lineStart)),
    )[0];
  if (!dominant) return;

  const [dominantProducer, dominantHeadings] = dominant;
  dominantHeadings.sort((left, right) => left.lineStart - right.lineStart);
  const nestedProducerCounts = new Map<string, number>();
  for (let index = 0; index < dominantHeadings.length - 1; index += 1) {
    const current = dominantHeadings[index]!;
    const next = dominantHeadings[index + 1]!;
    const currentPart = serializedPartIdentity(current.title);
    const nextPart = serializedPartIdentity(next.title);
    const interveningNumberedCandidates = acceptedNonStructural
      .filter(
        (candidate) =>
          producerFamily(candidate.family) !== dominantProducer &&
          candidate.lineStart > current.lineStart &&
          candidate.lineStart < next.lineStart &&
          current.number !== undefined &&
          next.number !== undefined &&
          candidate.number !== undefined &&
          candidate.number > current.number &&
          candidate.number < next.number,
      )
      .sort((left, right) => left.lineStart - right.lineStart);
    const bridgesNumberedProducerGap =
      current.number !== undefined &&
      next.number !== undefined &&
      next.number - current.number > 1 &&
      interveningNumberedCandidates.length === next.number - current.number - 1 &&
      interveningNumberedCandidates.every((candidate, gapIndex) => candidate.number === current.number! + gapIndex + 1);
    for (const candidate of acceptedNonStructural) {
      const candidatePart = serializedPartIdentity(candidate.title);
      const bridgesSerializedParts =
        currentPart &&
        candidatePart &&
        nextPart &&
        currentPart.base === candidatePart.base &&
        candidatePart.base === nextPart.base &&
        candidatePart.part === currentPart.part + 1 &&
        nextPart.part === candidatePart.part + 1;
      const bridgesNumberedRun = bridgesNumberedProducerGap && interveningNumberedCandidates.includes(candidate);
      if (
        producerFamily(candidate.family) !== dominantProducer &&
        candidate.lineStart > current.lineStart &&
        candidate.lineStart < next.lineStart &&
        !bridgesSerializedParts &&
        !bridgesNumberedRun
      ) {
        accepted.delete(candidate);
        const producer = producerFamily(candidate.family);
        nestedProducerCounts.set(producer, (nestedProducerCounts.get(producer) ?? 0) + 1);
      }
    }
  }

  const lastDominant = dominantHeadings.at(-1)!;
  const lastPart = serializedPartIdentity(lastDominant.title);
  for (const candidate of acceptedNonStructural) {
    const producer = producerFamily(candidate.family);
    if (
      candidate.lineStart <= lastDominant.lineStart ||
      producer === dominantProducer ||
      (nestedProducerCounts.get(producer) ?? 0) < 2
    ) {
      continue;
    }

    const candidatePart = serializedPartIdentity(candidate.title);
    const continuesSerializedRun =
      lastPart && candidatePart && lastPart.base === candidatePart.base && candidatePart.part === lastPart.part + 1;
    const continuesNumberedRun = lastDominant.number !== undefined && candidate.number === lastDominant.number + 1;
    if (!continuesSerializedRun && !continuesNumberedRun) accepted.delete(candidate);
  }
}

function bodyLengthUntilNextCandidate(text: string, heading: HeadingMatch, orderedCandidates: HeadingMatch[]): number {
  const index = orderedCandidates.indexOf(heading);
  const nextStart = index >= 0 ? (orderedCandidates[index + 1]?.lineStart ?? text.length) : text.length;
  return trimmedRangeLength(text, heading.contentStart, nextStart);
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
  const separators: StructuralSeparator[] = [];
  for (const line of scanLines(text)) {
    const marker = structuralSeparatorMarker(line.lineText);
    if (marker) {
      separators.push({
        marker,
        lineIndex: line.lineIndex,
        lineText: line.lineText,
        lineStart: line.lineStart,
        contentStart: Math.min(line.lineStart + line.lineText.length + 1, text.length),
        hasBlankBefore: line.hasBlankBefore,
        hasBlankAfter: line.hasBlankAfter,
      });
    }
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

  const structural = collectStructuralSeparatorHeadings(text, separators, candidates);
  candidates.push(...structural.headings);
  candidates.sort((left, right) => left.lineStart - right.lineStart);

  const accepted = new Set<HeadingMatch>();
  for (const candidate of candidates) {
    if (!candidate.requiresSequence && !structural.absorbed.has(candidate)) accepted.add(candidate);
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
  suppressHeadingsInsideStructuralSegments(text, candidates, structural.headings, accepted);
  suppressTinyChapterBoundaries(text, candidates, accepted);
  suppressHeadingsNestedInDominantProducer(candidates, accepted);
  suppressTinyChapterBoundaries(text, candidates, accepted);

  const resolved = candidates.filter((candidate) => accepted.has(candidate));
  resolved.forEach((heading, index) => {
    if (heading.family === 'structural_separator' && !heading.title) heading.title = `${index + 1}화`;
  });
  return resolved;
}
