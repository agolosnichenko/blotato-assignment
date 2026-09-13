import { defineConfig } from 'drizzle-kit';

// Two schemas, one migration history: platform-core's local projection and the comments module
// itself. Neither file exists yet (T016/T017) — drizzle-kit only reads this when db:generate runs.
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/modules/platform-core/schema.ts',
    './src/modules/comments/infrastructure/schema.ts',
  ],
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://comments:comments@localhost:5432/comments',
  },
});
