import {
  AutomationServiceError,
  RunServiceError,
  StudioServiceError,
} from "@lapis/services";

/**
 * Route-layer domain error: same shape as RunServiceError of the shared service
 * layer. Extending it lets a single instanceof branch in the app.ts error
 * mapping cover errors thrown by both layers.
 */
export class RunRouteError extends RunServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "RunRouteError";
  }
}

/** Studio route domain error: same shape as StudioServiceError. */
export class StudioRouteError extends StudioServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "StudioRouteError";
  }
}

/** Automation route domain error: same shape as AutomationServiceError. */
export class AutomationRouteError extends AutomationServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "AutomationRouteError";
  }
}
