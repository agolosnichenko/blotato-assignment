import { pathToFileURL } from 'node:url';
import { buildContainer } from '#src/app/container.ts';
import { createLogger } from '#src/shared/logger.ts';

async function main(): Promise<void> {
  const container = buildContainer();
  const logger = createLogger(container.config, { role: 'worker' });

  await container.database.ping();
  await container.redis.ping();
  logger.info('worker ready');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        logger.info({ signal }, 'shutting down');
        await container.close();
      })();
    });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
