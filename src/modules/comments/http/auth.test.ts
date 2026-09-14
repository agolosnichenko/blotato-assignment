/**
 * Unit tests for the auth module's route-exemption predicates.
 *
 * {@link isFullyPublicRoute} is the one `api.ts`'s OpenAPI `transform` uses, and the distinction it
 * draws only shows up on a route that answers several methods: `@fastify/swagger` calls `transform`
 * once per route, so clearing `security` there clears it for *every* operation that route produces.
 * Publishing a route as unauthenticated because one of its methods is exempt would contradict the
 * hook, which decides per method.
 */

import { describe, expect, it } from 'vitest';
import { isFullyPublicRoute, isPublicRoute } from '#src/modules/comments/http/auth.ts';

describe('isPublicRoute', () => {
  it('exempts the health probes', () => {
    expect(isPublicRoute('GET', '/healthz')).toBe(true);
    expect(isPublicRoute('GET', '/readyz')).toBe(true);
  });

  it('exempts the Meta webhook on both of its methods', () => {
    expect(isPublicRoute('GET', '/webhooks/meta')).toBe(true);
    expect(isPublicRoute('POST', '/webhooks/meta')).toBe(true);
  });

  it('requires a key for the comment collection', () => {
    expect(isPublicRoute('GET', '/v1/comments')).toBe(false);
  });

  it('does not widen /docs to a path that merely starts with the same characters', () => {
    expect(isPublicRoute('GET', '/docs')).toBe(true);
    expect(isPublicRoute('GET', '/docs/static/main.js')).toBe(true);
    expect(isPublicRoute('GET', '/docsomething')).toBe(false);
  });
});

describe('isFullyPublicRoute', () => {
  it('accepts a single exempt method', () => {
    expect(isFullyPublicRoute('GET', '/healthz')).toBe(true);
  });

  it('accepts an array whose every method is exempt', () => {
    expect(isFullyPublicRoute(['GET', 'POST'], '/webhooks/meta')).toBe(true);
  });

  it('refuses an array where only some methods are exempt', () => {
    expect(isFullyPublicRoute(['GET', 'DELETE'], '/webhooks/meta')).toBe(false);
  });

  it('refuses an empty method list rather than treating it as vacuously exempt', () => {
    expect(isFullyPublicRoute([], '/healthz')).toBe(false);
  });

  it('refuses an authenticated route', () => {
    expect(isFullyPublicRoute('GET', '/v1/comments')).toBe(false);
  });
});
