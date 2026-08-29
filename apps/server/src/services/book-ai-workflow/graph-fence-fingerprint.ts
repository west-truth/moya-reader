import { characterGraphIntegrityHash } from '@noveldesk/text-core/identity/ai';
import type { CharacterGraph } from '../../../../../src/providers/ai';

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Produces the semantic fingerprint used by the promotion fence.
 *
 * Database reads may return graph rows in a different order from the provider
 * result that created the revision. Only the outer entity order is normalized;
 * the persisted integrity fingerprint remains unchanged for compatibility.
 */
export function characterGraphFenceFingerprint(graph: CharacterGraph): string {
  return characterGraphIntegrityHash({
    ...graph,
    characters: [...graph.characters].sort(compareIds),
    relations: [...graph.relations].sort(compareIds),
  });
}
