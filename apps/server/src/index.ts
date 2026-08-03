import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = await buildServer(config);
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'server_shutdown_started');
  try {
    await app.close();
    app.log.info({ signal }, 'server_shutdown_completed');
    process.exit(0);
  } catch (error) {
    app.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'server_shutdown_failed');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
