import { FastifyInstance, FastifyReply } from 'fastify';
import type { Queue } from 'bullmq';
import pg from 'pg';

export interface ReadinessChecks {
  queue?: Pick<Queue, 'getJobCounts'>;
  checkObjectStorage?: () => Promise<void>;
}

interface ComponentStatus {
  ok: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function componentStatus(check: () => Promise<void>): Promise<ComponentStatus> {
  try {
    await check();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  checks: ReadinessChecks = {},
): Promise<void> {
  const healthHandler = async () => {
    await pool.query('select 1');
    return {
      ok: true,
      service: 'noveldesk-server',
      time: new Date().toISOString(),
    };
  };

  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  const readinessHandler = async (_request: unknown, reply: FastifyReply) => {
    const components: Record<string, ComponentStatus> = {
      database: await componentStatus(async () => {
        await pool.query('select 1');
      }),
    };

    if (checks.queue) {
      components.queue = await componentStatus(async () => {
        await checks.queue!.getJobCounts('waiting', 'active', 'delayed', 'failed');
      });
    }

    if (checks.checkObjectStorage) {
      components.objectStorage = await componentStatus(checks.checkObjectStorage);
    }

    const ok = Object.values(components).every((component) => component.ok);
    return reply.code(ok ? 200 : 503).send({
      ok,
      service: 'noveldesk-server',
      components,
      time: new Date().toISOString(),
    });
  };

  app.get('/ready', readinessHandler);
  app.get('/api/ready', readinessHandler);
}
