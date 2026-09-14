import { uuidv7 } from 'uuidv7';

/**
 * Generates a new UUIDv7 identifier.
 *
 * Ids are generated in the application, not the database, because the outbox row,
 * the BullMQ `jobId` and the HTTP `Location` header of a `202 queued` response all
 * need the id before the insert returns (R-06, A15).
 */
export function generateId(): string {
  return uuidv7();
}

declare const brand: unique symbol;

/** A string that carries what it identifies in its type, with no runtime representation. */
type Branded<T, B extends string> = T & { readonly [brand]: B };

/**
 * The tenant every repository call is scoped by (D20).
 *
 * Branded because the ids in this service are all bare strings of the same shape, and the
 * repository signatures put several of them side by side —
 * `getById(workspaceId, commentId)`. Swapping two adjacent arguments compiles
 * and produces exactly the cross-tenant read D20 forbids; only an integration test catches it.
 * `WorkspaceId` makes that swap a compile error instead.
 *
 * Only the workspace id is branded. It is the one that appears in *every* repository signature
 * and almost always next to another id, so it carries most of the risk for a fraction of the
 * churn that branding every id would cost.
 */
export type WorkspaceId = Branded<string, 'WorkspaceId'>;

/**
 * Marks a string as a workspace id.
 *
 * The narrowing points are deliberately few: the authenticated request (`http/auth.ts`), rows read
 * back from the database, and test fixtures. Reach for this anywhere else and the question to ask
 * first is where that string actually came from.
 */
export function asWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId;
}
