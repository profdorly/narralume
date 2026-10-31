import type {
  FastifyInstance,
  FastifyReply,
  RouteHandlerMethod,
} from "fastify";

import {
  LOCAL_OPERATOR,
  normalizeRouteResult,
  type RouteApp,
  type RouteMethod,
  type RouteResponse,
} from "@lapis/services";

/**
 * RouteApp → Fastify adapter: the same register*Routes functions register on
 * the HTTP host. The RouteResponse a handler returns (including a Uint8Array
 * body and headers) is translated into reply.code/header/send.
 */
export function fastifyRouteApp(app: FastifyInstance): RouteApp {
  return {
    route(method, path, handler, options) {
      const routeHandler: RouteHandlerMethod = async (request, reply) => {
        const result = normalizeRouteResult(
          await handler({
            method,
            path: request.url.split("?")[0] ?? request.url,
            params: (request.params ?? {}) as Record<string, string>,
            query: (request.query ?? {}) as Record<string, unknown>,
            body: request.body,
            headers: request.headers as Record<string, string>,
            log: request.log,
            auth: LOCAL_OPERATOR,
          }),
        );
        applyRouteResponse(reply, result);
      };
      if (options?.bodyLimit !== undefined) {
        registerWith(
          app,
          method,
          path,
          { bodyLimit: options.bodyLimit },
          routeHandler,
        );
      } else {
        registerWith(app, method, path, undefined, routeHandler);
      }
    },
  };
}

function registerWith(
  app: FastifyInstance,
  method: RouteMethod,
  path: string,
  options: { bodyLimit: number } | undefined,
  handler: RouteHandlerMethod,
): void {
  const method_ = method.toLowerCase() as
    "get" | "post" | "put" | "patch" | "delete";
  if (options) {
    app[method_](path, options, handler);
  } else {
    app[method_](path, handler);
  }
}

function applyRouteResponse(reply: FastifyReply, result: RouteResponse): void {
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      reply.header(key, value);
    }
  }
  reply.code(result.status);
  reply.send(result.body);
}
