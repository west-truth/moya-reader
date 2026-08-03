import type { FastifyReply } from 'fastify';
import {
  ProviderJobAdmissionError,
  providerJobAdmissionErrorBody,
} from '../../services/provider-job-admission/index.js';

export function sendProviderJobAdmissionRejection(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (!(error instanceof ProviderJobAdmissionError)) return undefined;
  if (error.retryAfterSeconds !== undefined) {
    reply.header('Retry-After', String(error.retryAfterSeconds));
  }
  return reply.code(429).send(providerJobAdmissionErrorBody(error));
}
