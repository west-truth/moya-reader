import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  LabelMutationConflictError,
  LabelMutationInputError,
} from '../../../../../src/providers/label-mutation-contract';
import type { ServerConfig } from '../../config.js';
import {
  applyHostedLabelCorrections,
  HostedLabelMutationFenceConflictError,
} from '../../services/label-mutations/label-mutation-service.js';
import { parseApplyLabelCorrectionsCommandV2 } from '../../services/label-mutations/label-mutation-request.js';

export async function registerLabelMutationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.post<{ Params: { bookId: string }; Body: unknown }>(
    '/api/books/:bookId/label-mutations',
    async (request, reply) => {
      try {
        const command = parseApplyLabelCorrectionsCommandV2(request.body);
        if (command.bookId !== request.params.bookId) {
          return reply.code(400).send({ error: 'path bookId does not match command bookId' });
        }
        return await applyHostedLabelCorrections(pool, config, command);
      } catch (error) {
        if (error instanceof LabelMutationInputError) {
          return reply.code(400).send({ error: error.message });
        }
        if (error instanceof HostedLabelMutationFenceConflictError) {
          return reply.code(409).send({
            error: error.message,
            reason: 'fence_changed',
            fence: error.fence,
            expected: error.expected,
            actual: error.actual,
          });
        }
        if (error instanceof LabelMutationConflictError) {
          return reply.code(409).send({ error: error.message, reason: error.reason });
        }
        if (error instanceof Error && /must be|is required|is invalid/.test(error.message)) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
