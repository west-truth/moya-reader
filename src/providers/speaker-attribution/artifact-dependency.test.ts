import { describe, expect, it } from 'vitest';
import {
  createSpeakerArtifactDependency,
  markSpeakerArtifactDependencyStale,
  planSpeakerDependencyInvalidation,
} from './artifact-dependency';

const dependencyInput = {
  bookId: 'book_1',
  contentRevisionId: 'revision_1',
  chapterId: 'chapter_1',
  sceneId: 'scene_1',
  artifactId: 'artifact_speaker_1',
  artifactKind: 'speaker_labels',
  level: 'L3_speaker' as const,
  dependencyIds: ['memory_2', 'inventory_1', 'memory_2'],
};

describe('speaker artifact dependency lineage', () => {
  it('keeps identity and fingerprint stable across creation time and stale state', () => {
    const active = createSpeakerArtifactDependency({
      ...dependencyInput,
      createdAt: '2026-07-13T00:00:00.000Z',
    });
    const recreatedAsStale = createSpeakerArtifactDependency({
      ...dependencyInput,
      dependencyIds: [...dependencyInput.dependencyIds].reverse(),
      status: 'stale',
      staleReason: 'source correction',
      createdAt: '2026-07-13T01:00:00.000Z',
    });
    const markedStale = markSpeakerArtifactDependencyStale(active, 'source correction');

    expect(recreatedAsStale.id).toBe(active.id);
    expect(recreatedAsStale.fingerprint).toBe(active.fingerprint);
    expect(markedStale).toMatchObject({
      id: active.id,
      fingerprint: active.fingerprint,
      status: 'stale',
      staleReason: 'source correction',
      createdAt: active.createdAt,
    });
  });

  it('requires coherent stale metadata', () => {
    expect(() => createSpeakerArtifactDependency({ ...dependencyInput, status: 'stale' })).toThrow(
      /requires a reason/i,
    );
    expect(() => createSpeakerArtifactDependency({ ...dependencyInput, staleReason: 'not stale' })).toThrow(
      /cannot have a stale reason/i,
    );
  });

  it('plans transitive invalidation without mutating lineage rows', () => {
    const speaker = createSpeakerArtifactDependency(dependencyInput);
    const voice = createSpeakerArtifactDependency({
      ...dependencyInput,
      artifactId: 'artifact_voice_1',
      artifactKind: 'voice_cast',
      level: 'L4_voice',
      dependencyIds: [speaker.artifactId],
    });

    expect(
      planSpeakerDependencyInvalidation({ rows: [speaker, voice], changedDependencyIds: ['inventory_1'] }).map(
        (row) => row.artifactId,
      ),
    ).toEqual([speaker.artifactId, voice.artifactId]);
    expect(speaker.status).toBe('active');
  });
});
