import type { SegmentType, VoiceProfile } from '@noveldesk/contracts';
import type { BookAIWorkflowPlanOptions } from '../../../../../src/providers/book-ai-workflow-plan';
import type { ProviderSecretName } from '../../providers/server-provider-secrets.js';

export function recordBody(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function optionalStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : undefined;
}

export function providerSecretName(value: unknown): ProviderSecretName | undefined {
  return value === 'api_key' || value === 'access_token' || value === 'credential_path' || value === 'endpoint_url'
    ? value
    : undefined;
}

export function numberField(body: Record<string, unknown>, field: string, fallback = 0): number {
  const value = body[field];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function booleanField(body: Record<string, unknown>, field: string, fallback = false): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'boolean' ? value : undefined;
}

export function positiveIntegerQuery(value: unknown, field: string): { value?: number; error?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (Array.isArray(value)) return { error: `${field} must be a positive integer` };
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? { value: parsed }
    : { error: `${field} must be a positive integer` };
}

export function workflowPlanOptionsFromQuery(
  query: Record<string, unknown>,
): { options: BookAIWorkflowPlanOptions } | { error: string } {
  const options: BookAIWorkflowPlanOptions = {};
  const fields: Array<keyof BookAIWorkflowPlanOptions> = [
    'maxBundleChapters',
    'targetBundleCharacters',
    'maxLabelingParagraphs',
    'targetLabelingCharacters',
  ];
  for (const field of fields) {
    const parsed = positiveIntegerQuery(query[field], field);
    if (parsed.error) return { error: parsed.error };
    if (parsed.value !== undefined) {
      (options as Record<string, number>)[field] = parsed.value;
    }
  }
  return { options };
}

export function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? value : undefined;
}

export function uniqueNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function stringRecord(value: unknown): Record<string, string> | undefined {
  const body = recordBody(value);
  if (!body) return undefined;
  const entries = Object.entries(body);
  if (!entries.every(([, item]) => typeof item === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function nestedRecord(value: unknown): Record<string, Record<string, unknown>> | undefined {
  const body = recordBody(value);
  if (!body) return undefined;
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(body)) {
    const record = recordBody(item);
    if (!record) return undefined;
    result[key] = record;
  }
  return result;
}

export function validConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validOffset(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export const segmentTypes: SegmentType[] = [
  'narration',
  'quoted_dialogue',
  'plain_dialogue',
  'inner_monologue',
  'system_message',
  'sfx',
  'author_note',
  'unknown',
];

export const voiceProfileRoles: VoiceProfile['role'][] = ['narrator', 'character', 'system', 'unknown'];
