/**
 * Placeholder for a future multi-user SaaS shell.
 * Today the product is single-operator / local-first: isolation is project_id.
 * Route handlers should accept AuthContext instead of assuming a global user.
 * A Postgres port would populate tenantId from the session, not from SQLite.
 */
export interface AuthContext {
  readonly operatorId: string | null;
  readonly tenantId: string | null;
}

export const LOCAL_OPERATOR: AuthContext = {
  operatorId: "local",
  tenantId: null,
};

export function projectScopeKey(auth: AuthContext, projectId: string): string {
  return auth.tenantId ? `${auth.tenantId}:${projectId}` : projectId;
}
