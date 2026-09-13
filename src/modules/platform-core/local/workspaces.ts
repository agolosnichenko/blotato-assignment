/** {@link Workspaces} against the local projection (D8, D29, T023). */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { workspaces } from '#src/modules/platform-core/schema.ts';
import {
  found,
  NOT_FOUND,
  type Found,
  type WorkspaceRecord,
  type Workspaces,
} from '#src/modules/platform-core/ports.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

export function createLocalWorkspaces(db: NodePgDatabase): Workspaces {
  return {
    async findById(workspaceId: WorkspaceId): Promise<Found<WorkspaceRecord>> {
      const [row] = await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          contactLimitMonthly: workspaces.contactLimitMonthly,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      return row === undefined ? NOT_FOUND : found(row);
    },
  };
}
