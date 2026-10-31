import type { AuthContext } from "./auth-context.js";
import { LOCAL_OPERATOR } from "./auth-context.js";

/**
 * Runtime-independent route registration interface: the same register*Routes
 * code registers on both Fastify (HTTP) and the browser kernel (Worker RPC).
 * The HTTP contract is the only API surface.
 *
 * The request a handler receives is already parsed (body/params/query are
 * plain JS values); it returns a RouteResponse (or a bare JSON value = 200).
 * Binary responses use a Uint8Array body + explicit headers. Thrown errors go
 * through the host's unified error mapping.
 */

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRequest {
  readonly method: RouteMethod;
  readonly path: string;
  /** Path parameters (:projectId, etc.), already decoded. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * Query parameters (dictionary after URL parsing; values are string or
   * string[]).
   */
  readonly query: Record<string, unknown>;
  /** JSON body (also allowed for DELETE). */
  readonly body: unknown;
  /**
   * Request headers (lowercase keys). Used only by a few endpoints, e.g. for
   * ETag negotiation.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Structured logger (may be a no-op on the kernel side). */
  readonly log: { warn(payload: unknown, message?: string): void };
  /** Identidade do operador. Hoje é sempre o operador local; SaaS preenche tenantId. */
  readonly auth: AuthContext;
}

export { LOCAL_OPERATOR };

export interface RouteResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export type RouteHandler = (
  request: RouteRequest,
) => Promise<RouteResponse | unknown> | RouteResponse | unknown;

export interface RouteOptions {
  /**
   * Request body limit (bytes). Maps to bodyLimit in Fastify; the kernel side
   * checks the JSON size.
   */
  readonly bodyLimit?: number;
}

export interface RouteApp {
  route(
    method: RouteMethod,
    path: string,
    handler: RouteHandler,
    options?: RouteOptions,
  ): void;
}

/**
 * Normalize a handler's return value: a bare value = 200 JSON; a RouteResponse
 * is passed through. The shared exit point of both host adapters.
 */
export function normalizeRouteResult(
  result: RouteResponse | unknown,
): RouteResponse {
  if (
    result !== null &&
    typeof result === "object" &&
    "status" in result &&
    typeof (result as RouteResponse).status === "number" &&
    ("body" in result ||
      "headers" in result ||
      (result as RouteResponse).body === undefined)
  ) {
    const response = result as RouteResponse;
    return {
      status: response.status,
      body: response.body,
      headers: response.headers,
    };
  }
  return { status: 200, body: result };
}
