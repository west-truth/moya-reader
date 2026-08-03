import type { SceneSpeakerPacketV3 } from './contracts';

export type SpeakerWireSchemaDialectV2 = 'json_schema' | 'gemini';

function geminiSpeakerWireV2Schema(packet: SceneSpeakerPacketV3): Record<string, unknown> {
  const targetCount = packet.targets.length;
  const candidateOrdinals = packet.candidates.map(([ordinal]) => ordinal);
  const maximumSpeakerOrdinal = Math.max(3, ...candidateOrdinals);
  const newMentionMappingCapacity = packet.newMentionOrdinalsByTarget.length;
  const mentionMaximum = Math.max(0, packet.mentions.length - 1);
  return {
    type: 'OBJECT',
    required: ['v', 'f', 's', 'q', 'e', 'u', 'c', 'r', 'x'],
    properties: {
      v: { type: 'INTEGER', minimum: 2, maximum: 2, description: 'Always 2.' },
      f: { type: 'STRING', description: 'Copy packet f exactly without changing it.' },
      s: {
        type: 'ARRAY',
        minItems: targetCount,
        maxItems: targetCount,
        description: `One grounded speaker ordinal per target, in target order, from 2..${maximumSpeakerOrdinal}.`,
        items: { type: 'INTEGER', minimum: 2, maximum: maximumSpeakerOrdinal },
      },
      q: {
        type: 'ARRAY',
        minItems: targetCount,
        maxItems: targetCount,
        description: 'One confidence integer per target, in target order.',
        items: { type: 'INTEGER', minimum: 0, maximum: 1_000 },
      },
      e: {
        type: 'ARRAY',
        minItems: targetCount,
        maxItems: targetCount,
        description: 'One evidence bit field per target, in target order.',
        items: { type: 'INTEGER', minimum: 0, maximum: 65_535 },
      },
      u: {
        type: 'ARRAY',
        maxItems: targetCount,
        description: 'Reviewed target positions. Length and order must exactly match c and r; otherwise use [].',
        items: { type: 'INTEGER', minimum: 0, maximum: Math.max(0, targetCount - 1) },
      },
      c: {
        type: 'ARRAY',
        maxItems: targetCount,
        description: 'Alternative speaker rows aligned one-to-one with u and r; otherwise use [].',
        items: {
          type: 'ARRAY',
          minItems: 1,
          maxItems: 3,
          items: { type: 'INTEGER', minimum: 2, maximum: maximumSpeakerOrdinal },
        },
      },
      r: {
        type: 'ARRAY',
        maxItems: targetCount,
        description: 'Review bit fields aligned one-to-one with u and c; otherwise use [].',
        items: { type: 'INTEGER', minimum: 0, maximum: 65_535 },
      },
      x: {
        type: 'ARRAY',
        maxItems: newMentionMappingCapacity,
        description:
          newMentionMappingCapacity === 0
            ? 'No new mention mappings are allowed in this packet. Return [].'
            : 'Unique [target position, mention ordinal] rows only when s or c uses 3 and packet n allows the pair.',
        items: {
          type: 'ARRAY',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'INTEGER',
            minimum: 0,
            maximum: Math.max(targetCount - 1, mentionMaximum),
          },
        },
      },
    },
  };
}

export function compileSpeakerWireV2Schema(
  packet: SceneSpeakerPacketV3,
  dialect: SpeakerWireSchemaDialectV2 = 'json_schema',
): Record<string, unknown> {
  if (dialect === 'gemini') return geminiSpeakerWireV2Schema(packet);
  const targetCount = packet.targets.length;
  const candidateOrdinals = packet.candidates.map(([ordinal]) => ordinal);
  const allowedSpeakerOrdinals = [2, 3, ...candidateOrdinals];
  const mentionMaximum = Math.max(0, packet.mentions.length - 1);
  return {
    title: 'SpeakerWireV2',
    type: 'object',
    additionalProperties: false,
    required: ['v', 'f', 's', 'q', 'e', 'u', 'c', 'r', 'x'],
    properties: {
      v: { type: 'integer', const: 2 },
      f: { type: 'string', const: packet.fingerprint },
      s: {
        type: 'array',
        minItems: targetCount,
        maxItems: targetCount,
        items: { type: 'integer', enum: allowedSpeakerOrdinals },
      },
      q: {
        type: 'array',
        minItems: targetCount,
        maxItems: targetCount,
        items: { type: 'integer', minimum: 0, maximum: 1_000 },
      },
      e: {
        type: 'array',
        minItems: targetCount,
        maxItems: targetCount,
        items: { type: 'integer', minimum: 0, maximum: 65_535 },
      },
      u: {
        type: 'array',
        maxItems: targetCount,
        items: { type: 'integer', minimum: 0, maximum: Math.max(0, targetCount - 1) },
      },
      c: {
        type: 'array',
        maxItems: targetCount,
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { type: 'integer', enum: allowedSpeakerOrdinals },
        },
      },
      r: {
        type: 'array',
        maxItems: targetCount,
        items: { type: 'integer', minimum: 0, maximum: 65_535 },
      },
      x: {
        type: 'array',
        maxItems: targetCount,
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          prefixItems: [
            { type: 'integer', minimum: 0, maximum: Math.max(0, targetCount - 1) },
            { type: 'integer', minimum: 0, maximum: mentionMaximum },
          ],
          items: false,
        },
      },
    },
  };
}
