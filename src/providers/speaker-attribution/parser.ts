import { SPEAKER_WIRE_VERSION, type SpeakerWireV2 } from './contracts';

function integerArray(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
    throw new Error(`SpeakerWireV2 ${field} must be an integer array`);
  }
  return value as number[];
}

export function parseSpeakerWireV2(value: unknown): SpeakerWireV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SpeakerWireV2 must be an object');
  }
  const row = value as Record<string, unknown>;
  const expectedKeys = ['c', 'e', 'f', 'q', 'r', 's', 'u', 'v', 'x'];
  const actualKeys = Object.keys(row).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('SpeakerWireV2 contains missing or additional fields');
  }
  if (row.v !== SPEAKER_WIRE_VERSION || typeof row.f !== 'string') {
    throw new Error('SpeakerWireV2 version or fingerprint is invalid');
  }
  if (!Array.isArray(row.c) || row.c.some((item) => !Array.isArray(item))) {
    throw new Error('SpeakerWireV2 c must be an array of integer arrays');
  }
  const candidates = row.c.map((item, index) => integerArray(item, `c[${index}]`));
  if (
    !Array.isArray(row.x) ||
    row.x.some((item) => !Array.isArray(item) || item.length !== 2 || item.some((part) => !Number.isInteger(part)))
  ) {
    throw new Error('SpeakerWireV2 x must contain integer pairs');
  }
  return {
    v: SPEAKER_WIRE_VERSION,
    f: row.f,
    s: integerArray(row.s, 's'),
    q: integerArray(row.q, 'q'),
    e: integerArray(row.e, 'e'),
    u: integerArray(row.u, 'u'),
    c: candidates,
    r: integerArray(row.r, 'r'),
    x: row.x as Array<[number, number]>,
  };
}

export function parseSpeakerWireV2Json(text: string): SpeakerWireV2 {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('```')) {
    throw new Error('SpeakerWireV2 response must be plain JSON without markdown fences');
  }
  return parseSpeakerWireV2(JSON.parse(trimmed));
}
