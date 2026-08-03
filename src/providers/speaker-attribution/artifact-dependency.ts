import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';

export type SpeakerArtifactDependencyLevelV1 = 'L0_source' | 'L1_inventory' | 'L2_memory' | 'L3_speaker' | 'L4_voice';

export interface SpeakerArtifactDependencyV1 {
  readonly version: 'speaker-artifact-dependency-v1';
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId?: string;
  readonly sceneId?: string;
  readonly burstId?: string;
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly level: SpeakerArtifactDependencyLevelV1;
  readonly dependencyIds: readonly string[];
  readonly status: 'active' | 'stale';
  readonly staleReason?: string;
  readonly createdAt: string;
  readonly fingerprint: string;
}

type SpeakerArtifactDependencyInput = Omit<
  SpeakerArtifactDependencyV1,
  'version' | 'id' | 'fingerprint' | 'status' | 'staleReason' | 'createdAt'
> & {
  readonly status?: SpeakerArtifactDependencyV1['status'];
  readonly staleReason?: string;
  readonly createdAt?: string;
};

function normalizedDependencyIds(dependencyIds: readonly string[]): readonly string[] {
  return [...new Set(dependencyIds)].sort();
}

function immutableLineage(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId?: string;
  readonly sceneId?: string;
  readonly burstId?: string;
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly level: SpeakerArtifactDependencyLevelV1;
  readonly dependencyIds: readonly string[];
}) {
  return {
    version: 'speaker-artifact-dependency-v1' as const,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    sceneId: input.sceneId,
    burstId: input.burstId,
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    level: input.level,
    dependencyIds: normalizedDependencyIds(input.dependencyIds),
  };
}

function dependencyIdentity(lineage: ReturnType<typeof immutableLineage>): {
  readonly id: string;
  readonly fingerprint: string;
} {
  const fingerprint = structuredIntegrityHash(lineage);
  return {
    id: persistentId128('speaker_artifact_dependency', [lineage.artifactId, lineage.level, fingerprint]),
    fingerprint,
  };
}

function assertStatus(status: SpeakerArtifactDependencyV1['status'], staleReason?: string): void {
  if (status === 'stale' && !staleReason?.trim()) {
    throw new Error('A stale speaker artifact dependency requires a reason');
  }
  if (status === 'active' && staleReason !== undefined) {
    throw new Error('An active speaker artifact dependency cannot have a stale reason');
  }
}

export function createSpeakerArtifactDependency(input: SpeakerArtifactDependencyInput): SpeakerArtifactDependencyV1 {
  const status = input.status ?? 'active';
  assertStatus(status, input.staleReason);
  const lineage = immutableLineage(input);
  return {
    ...lineage,
    ...dependencyIdentity(lineage),
    status,
    staleReason: input.staleReason?.trim(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function assertSpeakerArtifactDependency(row: SpeakerArtifactDependencyV1): void {
  assertStatus(row.status, row.staleReason);
  const lineage = immutableLineage(row);
  const expected = dependencyIdentity(lineage);
  if (row.fingerprint !== expected.fingerprint || row.id !== expected.id) {
    throw new Error(`Speaker artifact dependency ${row.id} has invalid immutable lineage`);
  }
}

export function markSpeakerArtifactDependencyStale(
  row: SpeakerArtifactDependencyV1,
  staleReason: string,
): SpeakerArtifactDependencyV1 {
  assertSpeakerArtifactDependency(row);
  const reason = staleReason.trim();
  if (!reason) throw new Error('A stale speaker artifact dependency requires a reason');
  if (row.status === 'stale') return row;
  return { ...row, status: 'stale', staleReason: reason };
}

export function planSpeakerDependencyInvalidation(input: {
  readonly rows: readonly SpeakerArtifactDependencyV1[];
  readonly changedDependencyIds: readonly string[];
}): readonly SpeakerArtifactDependencyV1[] {
  const changed = new Set(input.changedDependencyIds);
  const staleArtifacts = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const row of input.rows) {
      if (staleArtifacts.has(row.artifactId)) continue;
      if (row.dependencyIds.some((id) => changed.has(id) || staleArtifacts.has(id))) {
        staleArtifacts.add(row.artifactId);
        progressed = true;
      }
    }
  }
  return input.rows.filter((row) => staleArtifacts.has(row.artifactId));
}
