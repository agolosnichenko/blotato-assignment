import { defineRailway, postgres, project, redis, service } from 'railway/iac';

/**
 * Railway project for T111 (D24): `api` and `worker` are two services built from the same
 * Dockerfile, differing only in their start command (spec.md §4.1 — this is one deployable unit
 * with two runtime roles, not two services). Postgres and Redis are Railway's managed databases.
 *
 * This file is authored but not applied — the repository owner runs `railway config plan` then
 * `railway config apply` themselves (no credentials or external resources were touched writing
 * this). Before the first apply:
 *   1. `railway link` the directory to the target project and environment, so `plan` diffs against
 *      the right environment rather than prompting for one.
 *   2. Create CREDENTIALS_ENCRYPTION_KEY, META_APP_SECRET, META_APP_SECRET_INSTAGRAM and
 *      META_WEBHOOK_VERIFY_TOKEN as environment-level *shared* variables (Railway dashboard →
 *      environment → Variables → Shared) — ctx.shared only references a value that already
 *      exists there, it never creates or stores one, so no secret value is ever committed here
 *      (D25).
 *   3. Create a "production" GitHub Environment with a RAILWAY_TOKEN secret (a project-scoped
 *      token, not the broader account-scoped RAILWAY_API_TOKEN) for the deploy job in
 *      .github/workflows/ci.yml.
 *
 * Every other variable src/app/config.ts validates (HOST, PORT, LOG_LEVEL,
 * CREDENTIALS_KEY_VERSION, META_GRAPH_API_VERSION, BLUESKY_THREAD_DEPTH, RETENTION_DAYS, the six
 * SYNC_INTERVALS_*, SYNC_MANUAL_COOLDOWN_SECONDS, RATE_LIMIT_READS_PER_MIN,
 * RATE_LIMIT_WRITES_PER_MIN) has a default and is deliberately left unset — add one in the
 * Railway dashboard only once a default stops being right, not speculatively here. PORT
 * especially must stay unset: Railway assigns it, and config.ts already reads whatever Railway
 * sets, so a literal value here would fight that assignment.
 *
 * `.oxlintrc.json` overrides `max-lines-per-function` for this directory with
 * `skipComments: true` (JSON takes no comment, so the reason lives here): the builder below is one
 * declarative resource graph whose length is comment, and splitting it would scatter the
 * infrastructure across functions for no reader's benefit. The 50-line cap still applies to code.
 */
export default defineRailway((ctx) => {
  const db = postgres('postgres');

  // Redis persistence (S3, spec.md §17, plan.md Complexity Tracking) is unverified — this
  // declares Railway's managed Redis database and leaves S3 open, per the owner's instruction.
  // Railway's own guide (docs.railway.com/guides/redis-cache-vs-store) documents `noeviction` as
  // that database's default policy, which covers half of what BullMQ needs (§9.2); whether it
  // also accepts the AOF persistence half is what S3 must confirm — there is no documented way to
  // pass Redis start-command flags to the `redis()` helper to set it explicitly either way.
  //
  // Fallback if S3 comes back negative (changes this file only, not application code, per the
  // Complexity Tracking table): delete the `cache` line below and replace it with
  //
  //   const cache = service('redis', {
  //     source: image('redis:8.10.1-alpine'),
  //     start: 'redis-server --maxmemory-policy noeviction --appendonly yes --appendfsync everysec',
  //     volumeMounts: { '/data': volume('redis-data', { sizeMB: 1024 }) },
  //   });
  //
  // which is exactly docker-compose.yml's local Redis config, and set REDIS_URL on `api`/`worker`
  // by hand (redis://redis.railway.internal:6379) since a plain service has no `.env.REDIS_URL`.
  const cache = redis('redis');

  // Neither service declares a `source`. A `github()` source would make Railway watch `main` and
  // deploy both services itself, in parallel, the moment a commit lands — which contradicts D24's
  // ordering requirement (api's pre-deploy migration must finish before worker starts against the
  // new schema) and would be a second deploy trigger beside the one T111 actually specifies,
  // ".github/workflows/". Omitting `source` is the documented way to have this file own service
  // settings without declaring a repository or image
  // (docs.railway.com/infrastructure-as-code/reference); the code itself arrives through the
  // `railway up` steps in .github/workflows/ci.yml, which deploy api first and wait for SUCCESS.
  // Railway builds those uploads with the repository's Dockerfile, the same image both services run.

  // Bracket access because `ctx.shared` is an index signature and tsconfig sets
  // `noPropertyAccessFromIndexSignature` — this file is in `tsc --noEmit`'s input, so the DSL is
  // checked against the installed `railway` package rather than taken on trust.
  const sharedSecrets = {
    CREDENTIALS_ENCRYPTION_KEY: ctx.shared['CREDENTIALS_ENCRYPTION_KEY'],
    META_APP_SECRET: ctx.shared['META_APP_SECRET'],
    META_APP_SECRET_INSTAGRAM: ctx.shared['META_APP_SECRET_INSTAGRAM'],
    META_WEBHOOK_VERIFY_TOKEN: ctx.shared['META_WEBHOOK_VERIFY_TOKEN'],
  };

  // dist/migrate.mjs (scripts/migrate.ts) calls drizzle-orm's own `migrate()` against the
  // committed drizzle/ folder — the same function src/shared/testing/containers.ts uses for every
  // integration test. drizzle-orm is already a production dependency, so this needs no package
  // outside what the Dockerfile's --prod install already includes, and no devDependency
  // (drizzle-kit, used only to *generate* migrations) ever has to reach the runtime image.
  const migrate = 'node dist/migrate.mjs';

  const api = service('api', {
    start: 'node dist/api.mjs',
    // Runs before api serves traffic (D24). drizzle-orm's migrate() takes no lock against
    // concurrent runs (github.com/drizzle-team/drizzle-orm/issues/874) and must run exactly once
    // per deploy, so
    // only api declares it — worker relies on the GitHub Actions deploy job deploying api first
    // and waiting for SUCCESS (see .github/workflows/ci.yml) rather than a second preDeploy here.
    // Every migration must stay compatible with the *previous* release's code for the whole
    // rollout: that previous release keeps serving traffic against the new schema until it is
    // itself redeployed.
    preDeploy: migrate,
    healthcheck: '/healthz',
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      ...sharedSecrets,
    },
  });

  const worker = service('worker', {
    start: 'node dist/worker.mjs',
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      ...sharedSecrets,
    },
  });

  return project('blotato-comments', {
    resources: [db, cache, api, worker],
  });
});
