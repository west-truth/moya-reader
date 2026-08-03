import { persistentId128 } from '@noveldesk/text-core/hash';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { characterGraphRevision } from '../../domain/resource-revisions';
import type { Character } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { CHARACTER_GRAPH_KNOWLEDGE_VERSION, type CharacterGraphKnowledgeV2 } from '../../providers/character-graph-v2';

const EMPTY_KNOWLEDGE = (novelId: string): CharacterGraphKnowledgeV2 => ({
  version: CHARACTER_GRAPH_KNOWLEDGE_VERSION,
  novelId,
  facts: [],
  mentions: [],
  addressTerms: [],
  speechTraits: [],
  relationFacts: [],
  evidence: [],
  mergeCandidates: [],
  redirects: [],
});

export function useCharacterGraphKnowledgeController(input: {
  readonly repository: ReaderRepository;
  readonly novelId?: string;
  readonly characters: readonly Character[];
  readonly onApplied: () => Promise<void>;
}) {
  const [knowledge, setKnowledge] = useState<CharacterGraphKnowledgeV2>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = useRef(input);
  current.current = input;

  const refresh = useCallback(async () => {
    const { novelId, repository } = current.current;
    if (!novelId) {
      setKnowledge(undefined);
      return;
    }
    try {
      setKnowledge(await repository.getCharacterGraphKnowledgeV2(novelId));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [input.characters, input.novelId, refresh]);

  const decideFact = useCallback(
    async (factId: string, decision: 'active' | 'rejected') => {
      const snapshot = knowledge;
      if (!snapshot || busy) return;
      const fact = snapshot.facts.find((item) => item.id === factId);
      if (!fact) return;
      setBusy(true);
      try {
        const updated = { ...fact, status: decision, source: 'user' as const, lockedByUser: decision === 'active' };
        await current.current.repository.saveCharacterGraphObservationsV2({
          ...EMPTY_KNOWLEDGE(snapshot.novelId),
          facts: [updated],
        });
        setKnowledge({ ...snapshot, facts: snapshot.facts.map((item) => (item.id === factId ? updated : item)) });
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, knowledge],
  );

  const mergeCandidate = useCallback(
    async (candidateId: string) => {
      const snapshot = knowledge;
      const { novelId, repository, characters, onApplied } = current.current;
      if (!snapshot || !novelId || busy) return;
      const candidate = snapshot.mergeCandidates.find((item) => item.id === candidateId && item.status === 'open');
      if (!candidate) return;
      setBusy(true);
      try {
        const relations = await repository.listCharacterRelations(novelId);
        await repository.applyCharacterIdentityCommandV2({
          kind: 'merge_characters_v2',
          operationId: persistentId128('character_identity_merge', [candidate.id, novelId]),
          novelId,
          sourceCharacterId: candidate.sourceCharacterId,
          targetCharacterId: candidate.targetCharacterId,
          expectedGraphRevision: characterGraphRevision(characters, relations),
          selectedFactIds: snapshot.facts
            .filter((fact) => fact.characterId === candidate.sourceCharacterId)
            .map((fact) => fact.id),
          voiceConflictPolicy: 'require_review',
          createdAt: new Date().toISOString(),
        });
        await onApplied();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, knowledge, refresh],
  );

  const splitFact = useCallback(
    async (factId: string, canonicalName: string) => {
      const snapshot = knowledge;
      const { novelId, repository, characters, onApplied } = current.current;
      const name = canonicalName.trim();
      if (!snapshot || !novelId || !name || busy) return;
      const fact = snapshot.facts.find((item) => item.id === factId);
      const source = fact ? characters.find((character) => character.id === fact.characterId) : undefined;
      if (!fact || !source) return;
      setBusy(true);
      try {
        const relations = await repository.listCharacterRelations(novelId);
        const id = persistentId128('character_split_v2', [novelId, fact.id, name]);
        await repository.applyCharacterIdentityCommandV2({
          kind: 'split_character_v2',
          operationId: persistentId128('character_identity_split', [novelId, fact.id, id]),
          novelId,
          sourceCharacterId: source.id,
          newCharacter: {
            id,
            novelId,
            canonicalName: name,
            aliases: [],
            color: source.color,
            confidence: 1,
            isUserConfirmed: true,
          },
          expectedGraphRevision: characterGraphRevision(characters, relations),
          movedFactIds: [fact.id],
          movedMentionIds: [],
          movedEvidenceIds: [...fact.evidenceIds],
          createdAt: new Date().toISOString(),
        });
        await onApplied();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, knowledge, refresh],
  );

  return useMemo(
    () => ({ knowledge, busy, error, refresh, decideFact, mergeCandidate, splitFact }),
    [busy, decideFact, error, knowledge, mergeCandidate, refresh, splitFact],
  );
}
