/**
 * Service-layer domain error: code lets API consumers branch programmatically,
 * statusCode is translated by the HTTP layer. The service layer knows nothing
 * about Fastify; the status code is kept here as a continuation of the route
 * error shape, so the app.ts error mapping does not need a separate table for
 * each of its 25 branches.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
