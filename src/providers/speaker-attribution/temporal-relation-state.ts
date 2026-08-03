import type { AddressUseEventV1 } from './address-event';
import type { TemporalRelationEdgeV1 } from './temporal-relation';

export function activeAddressUseEvents(events: readonly AddressUseEventV1[]): readonly AddressUseEventV1[] {
  const superseded = new Set(events.flatMap((event) => (event.supersedesEventId ? [event.supersedesEventId] : [])));
  return events
    .filter((event) => !superseded.has(event.id) && event.status !== 'rejected' && event.status !== 'superseded')
    .sort((left, right) => left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id));
}

export function activeTemporalRelationEdges(
  edges: readonly TemporalRelationEdgeV1[],
): readonly TemporalRelationEdgeV1[] {
  const superseded = new Set(edges.flatMap((edge) => (edge.supersedesEdgeId ? [edge.supersedesEdgeId] : [])));
  return edges
    .filter((edge) => !superseded.has(edge.id) && !['rejected', 'superseded'].includes(edge.status))
    .sort((left, right) => left.id.localeCompare(right.id));
}
