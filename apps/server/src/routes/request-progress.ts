import type { FastifyInstance } from 'fastify';
import type { TaskProgress, TaskProgressCallback } from '@noveldesk/contracts';

/** Ephemeral telemetry only. The original request still owns execution/cancellation. */
export function requestProgress(app: FastifyInstance, route: string) {
  const entries = new Map<string, { value: TaskProgress; expires: number }>();
  app.addHook('onClose', async () => entries.clear());
  app.get<{ Params: { progressId: string } }>(route, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const entry = entries.get(request.params.progressId);
    if (!entry || entry.expires < Date.now()) {
      entries.delete(request.params.progressId);
      return reply.code(404).send({ error: 'progress_unavailable' });
    }
    return reply.send(entry.value);
  });
  return (query: unknown): TaskProgressCallback => {
    const id = (query as { progressId?: unknown } | null)?.progressId;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return () => {};
    for (const [key, entry] of entries) if (entry.expires < Date.now()) entries.delete(key);
    // Never replace a concurrently owned ID or make telemetry a prerequisite for work.
    if (entries.has(id) || entries.size >= 64) return () => {};
    const entry = { value: { phase: 'preparing' } as TaskProgress, expires: Date.now() + 60 * 60_000 };
    entries.set(id, entry);
    return (value) => {
      entry.value = value;
      entry.expires = Date.now() + (value.phase === 'finalizing' ? 60_000 : 60 * 60_000);
    };
  };
}
