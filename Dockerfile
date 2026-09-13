FROM node:22.22.1-slim AS base
ENV PNPM_HOME=/pnpm CI=true
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable

FROM base AS build
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
# scripts/migrate.ts bundles to dist/migrate.mjs (Railway's pre-deploy command, D24) alongside
# api.mjs and worker.mjs; the other scripts in this directory are operator CLIs, not bundled.
COPY scripts ./scripts
RUN pnpm build

FROM base AS production-deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22.22.1-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# dist/migrate.mjs (scripts/migrate.ts) is Railway's pre-deploy command (D24) and reads these SQL
# files directly — it takes DATABASE_URL from the environment, so drizzle.config.ts itself isn't
# needed in this image (that file is for drizzle-kit, a devDependency absent here by design).
COPY drizzle ./drizzle
USER node
# Overridden to dist/worker.mjs for the worker service (spec 4.1).
CMD ["node", "dist/api.mjs"]
