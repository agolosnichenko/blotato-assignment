/**
 * Signal-handler plumbing shared by the two roles (`api.ts`, `worker.ts`).
 *
 * Both roles shut down the same way and had the same two gaps. A handler that does
 * `void shutdown(...)` drops the promise: a rejecting `close()` becomes an unhandled rejection at
 * the exact moment the process is trying to exit, which is the worst time for a message to be
 * easy to miss. And nothing bounded how long `close()` could take — a BullMQ worker waiting on a
 * job that never finishes leaves the process alive until the orchestrator's own SIGKILL timeout,
 * which shows up as a slow deploy rather than as a stuck shutdown.
 */

/** The slice of pino these handlers need. */
export interface ShutdownLogger {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

/**
 * How long a graceful shutdown may take before the process exits anyway.
 *
 * Comfortably longer than a healthy drain and comfortably shorter than a typical orchestrator's
 * SIGKILL grace period, so the exit below is the one that happens and it carries a log line.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Registers SIGTERM/SIGINT handlers that run `close` once, with a deadline.
 *
 * Args:
 *   close: The role's own teardown — closing workers, queues, the server and the container.
 *   logger: Where the outcome is reported.
 *
 * A failed or timed-out shutdown exits non-zero, so the failure is visible to whatever supervises
 * the process. A successful one returns and lets the event loop drain on its own, which keeps
 * pino's final flush intact.
 */
export function onShutdownSignal(close: () => Promise<void>, logger: ShutdownLogger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down');

      const deadline = setTimeout(() => {
        logger.error(
          { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
          'shutdown did not finish in time; exiting anyway',
        );
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      // `void` is safe here only because `run` handles every rejection itself — that is the whole
      // point of this helper, so it must stay that way.
      const run = async (): Promise<void> => {
        try {
          await close();
          clearTimeout(deadline);
          logger.info({ signal }, 'shutdown complete');
        } catch (error) {
          clearTimeout(deadline);
          logger.error({ signal, err: error }, 'shutdown failed');
          process.exit(1);
        }
      };
      void run();
    });
  }
}
