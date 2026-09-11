import { pathToFileURL } from 'node:url';
import { loadConfig } from '#src/app/config.ts';
import { createDatabase } from '#src/shared/db.ts';
import { createLogger } from '#src/shared/logger.ts';
import { createRedis } from '#src/shared/queue.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, { role: 'worker' });
  const database = createDatabase(config);
  const redis = createRedis(config);

  await database.ping();
  await redis.ping();
  logger.info('worker ready');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        logger.info({ signal }, 'shutting down');
        await database.close();
        redis.disconnect();
      })();
    });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
