import { LOCAL_OPERATOR } from "./auth-context.js";
import {
  normalizeRouteResult,
  type RouteApp,
  type RouteHandler,
  type RouteMethod,
  type RouteRequest,
  type RouteResponse,
} from "./route-app.js";

/**
 * Kernel route table: the collecting implementation of RouteApp.
 * register*Routes register their handlers here, and dispatch matches by
 * method+path (extracting :param), for the browser kernel RPC. It shares the
 * same registration functions with the Fastify host, so behavior is identical
 * by construction.
 */
export class RouteTable implements RouteApp {
  readonly #routes: {
    method: RouteMethod;
    segments: string[];
    handler: RouteHandler;
  }[] = [];

  route(method: RouteMethod, path: string, handler: RouteHandler): void {
    this.#routes.push({
      method,
      segments: path.split("/").filter(Boolean),
      handler,
    });
  }

  dispatch(
    method: RouteMethod,
    path: string,
    context: Pick<RouteRequest, "body" | "query" | "headers" | "log">,
  ): Promise<RouteResponse> {
    const target = path.split("?")[0] ?? path;
    const segments = target.split("/").filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      return Promise.resolve(
        route.handler({
          method,
          path: target,
          params,
          query: context.query,
          body: context.body,
          headers: context.headers,
          log: context.log,
          auth: LOCAL_OPERATOR,
        }),
      ).then((result) => normalizeRouteResult(result));
    }
    return Promise.reject(
      Object.assign(new Error("Route not found"), {
        code: "route.not_found",
        statusCode: 404,
      }),
    );
  }
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const spec = pattern[index]!;
    if (spec.startsWith(":")) {
      params[spec.slice(1)] = decodeURIComponent(actual[index]!);
    } else if (spec !== actual[index]) {
      return null;
    }
  }
  return params;
}
