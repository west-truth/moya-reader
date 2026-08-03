import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  normalizeCorrelationValue,
  requestCorrelationContext,
  runWithCorrelation,
  type CorrelationContext,
} from './context.js';
import type { StructuredLogger } from './logger.js';

const requestContexts = new WeakMap<object, CorrelationContext>();
const requestStartedAt = new WeakMap<object, number>();

export function registerRequestObservability(app: FastifyInstance, logger: StructuredLogger): void {
  app.addHook('onRequest', (request, reply, done) => {
    const context = requestCorrelationContext(request.headers);
    requestContexts.set(request, context);
    requestStartedAt.set(request, performance.now());
    reply.header('X-Request-Id', context.requestId);
    reply.header('X-Correlation-Id', context.correlationId);
    runWithCorrelation(context, done);
  });

  app.addHook('preHandler', (request, _reply, done) => {
    const context = requestContexts.get(request);
    if (context) addRouteCorrelation(context, request);
    if (context) runWithCorrelation(context, done);
    else done();
  });

  app.addHook('onError', (request, _reply, error, done) => {
    const context = requestContexts.get(request);
    const logError = () => logger.error('http_request_failed', { errorName: error.name });
    if (context) runWithCorrelation(context, logError);
    else logError();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const context = requestContexts.get(request);
    const startedAt = requestStartedAt.get(request);
    const logResponse = () =>
      logger.info('http_request_completed', {
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: startedAt === undefined ? undefined : Math.max(0, Math.round(performance.now() - startedAt)),
      });
    if (context) runWithCorrelation(context, logResponse);
    else logResponse();
    done();
  });
}

function addRouteCorrelation(context: CorrelationContext, request: FastifyRequest): void {
  if (!request.params || typeof request.params !== 'object') return;
  const params = request.params as Record<string, unknown>;
  const jobId = normalizeCorrelationValue(params.jobId);
  const workflowId = normalizeCorrelationValue(params.workflowId);
  if (jobId) context.jobId = jobId;
  if (workflowId) context.workflowId = workflowId;
}
