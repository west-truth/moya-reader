import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { CharacterIdentityConflictError } from '../../../../../src/providers/character-identity-operation';
import {
  CHARACTER_GRAPH_KNOWLEDGE_VERSION,
  parseCharacterIdentityCommandV2,
  type CharacterGraphKnowledgeV2,
} from '../../../../../src/providers/character-graph-v2';
import {
  applyHostedCharacterIdentityCommandV2,
  loadCharacterGraphKnowledgeForBookV2,
  saveCharacterGraphObservationsV2,
} from '../../services/character-graph-v2-service.js';
import { bookExists } from './workflow-query-service.js';

function parseKnowledge(value: unknown, bookId: string): CharacterGraphKnowledgeV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('knowledge must be an object');
  const body = value as Partial<CharacterGraphKnowledgeV2>;
  if (body.version !== CHARACTER_GRAPH_KNOWLEDGE_VERSION || body.novelId !== bookId) {
    throw new Error('knowledge version or book id is invalid');
  }
  for (const key of [
    'facts',
    'mentions',
    'addressTerms',
    'speechTraits',
    'relationFacts',
    'evidence',
    'mergeCandidates',
    'redirects',
  ] as const) {
    if (!Array.isArray(body[key]) || body[key].length > 10_000) throw new Error(`knowledge.${key} is invalid`);
  }
  return body as CharacterGraphKnowledgeV2;
}

export async function registerCharacterGraphV2Routes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/character-graph-v2', async (request, reply) => {
    if (!(await bookExists(pool, config, request.params.bookId)))
      return reply.code(404).send({ error: 'book not found' });
    return {
      knowledge: await loadCharacterGraphKnowledgeForBookV2(pool, config.defaultUserId, request.params.bookId),
    };
  });

  app.post<{ Params: { bookId: string }; Body: { knowledge?: unknown } }>(
    '/api/books/:bookId/character-graph-v2/observations',
    async (request, reply) => {
      if (!(await bookExists(pool, config, request.params.bookId)))
        return reply.code(404).send({ error: 'book not found' });
      try {
        const knowledge = parseKnowledge(request.body?.knowledge, request.params.bookId);
        await saveCharacterGraphObservationsV2(pool, config.defaultUserId, knowledge);
        return { ok: true };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid observations' });
      }
    },
  );

  app.post<{ Params: { bookId: string }; Body: { command?: unknown } }>(
    '/api/books/:bookId/character-identity-operations',
    async (request, reply) => {
      if (!(await bookExists(pool, config, request.params.bookId)))
        return reply.code(404).send({ error: 'book not found' });
      let command;
      try {
        command = parseCharacterIdentityCommandV2(request.body?.command);
        if (command.novelId !== request.params.bookId) throw new Error('command book id is invalid');
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid command' });
      }
      try {
        return { result: await applyHostedCharacterIdentityCommandV2(pool, config.defaultUserId, command) };
      } catch (error) {
        if (error instanceof CharacterIdentityConflictError) {
          return reply.code(409).send({ error: error.message, reason: error.reason });
        }
        throw error;
      }
    },
  );
}
