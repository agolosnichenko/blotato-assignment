import { defineRailway, image, postgres, project, service, volume } from 'railway/iac';

/**
 * Railway project for T111 (D24): `api` and `worker` are two services built from the same
 * Dockerfile, differing only in their start command (spec.md §4.1 — this is one deployable unit
 * with two runtime roles, not two services). Postgres is Railway's managed database; Redis is not
 * (see the S3 result below).
 *
 * Applied to the `blotato-comments` project, environment `production`. Two things live outside
 * this file and have to exist before an apply reaches a fresh environment:
 *   1. CREDENTIALS_ENCRYPTION_KEY, META_APP_SECRET, META_APP_SECRET_INSTAGRAM and
 *      META_WEBHOOK_VERIFY_TOKEN as environment-level *shared* variables — ctx.shared only
 *      references a value that already exists there, it never creates or stores one, so no secret
 *      value is ever committed here (D25).
 *   2. A "production" GitHub Environment with a RAILWAY_TOKEN secret (a project-scoped token, not
 *      the broader account-scoped RAILWAY_API_TOKEN) for the deploy job in
 *      .github/workflows/ci.yml. Only the CI deploy path needs it; `railway up` run by hand does
 *      not.
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

  // S3 came back half negative (spec.md §17): Railway's managed Redis reported `noeviction` — its
  // default — but `appendonly no`, and the `redis()` helper takes no server flags, so persistence
  // cannot be turned on from configuration. This is the fallback the Complexity Tracking table
  // pre-committed to, and it changes deployment configuration only.
  //
  // The flags and the image are docker-compose.yml's, so the deployment and a local run now hold
  // the same two guarantees §9.2 asks for: no job is evicted when memory fills, and the queue
  // survives a restart. `appendfsync everysec` is the AOF default and bounds a crash to one second
  // of writes — the alternative, `always`, costs an fsync per command for work Postgres already
  // records durably.
  // Named `cache`, not `redis`: Railway's IaC matches resources by name, and the managed database
  // this replaces was called `redis`. Reusing that name made the apply an in-place update of the
  // old resource rather than a create — including its leftover volume, which failed the "a service
  // can only have one volume" invariant even after the database itself was deleted. A distinct name
  // makes this unambiguously a new resource.
  const cacheVolume = volume('cache-data', { sizeMB: 1024 });
  const cache = service('cache', {
    source: image('redis:8.10.1-alpine'),
    start: 'redis-server --maxmemory-policy noeviction --appendonly yes --appendfsync everysec',
    volumeMounts: { '/data': cacheVolume },
  });
  // A plain service has no `.env.REDIS_URL` to reference, so the address is written out. It is the
  // private network name Railway gives the service, reachable only from inside this project's
  // environment — the same reason docker-compose's Redis publishes no password locally.
  const redisUrl = 'redis://cache.railway.internal:6379';

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
      REDIS_URL: redisUrl,
      ...sharedSecrets,
    },
  });

  const worker = service('worker', {
    start: 'node dist/worker.mjs',
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: redisUrl,
      ...sharedSecrets,
    },
  });

  return project('blotato-comments', {
    resources: [db, cache, cacheVolume, api, worker],
  });
});
