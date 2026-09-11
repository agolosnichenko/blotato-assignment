import { Redis } from 'ioredis';
import type { Config } from '#src/app/config.ts';

/**
 * Creates the Redis connection shared by BullMQ queues and workers.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: blocking commands must wait
 * instead of failing after a fixed number of retries.
 */
export function createRedis(config: Config): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}
