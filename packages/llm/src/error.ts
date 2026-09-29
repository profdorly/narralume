import type {
  ModelCallTiming,
  ModelErrorCategory,
  SerializedModelError,
} from "./types.js";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /((?:api[_-]?key|authorization|x-api-key)["'\s:=]+)([^\s,"'}]+)/gi,
] as const;

export interface ModelErrorOptions {
  category: ModelErrorCategory;
  retryable?: boolean;
  /** Stable machine-readable reason, e.g. "request_start_timeout". */
  code?: string;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
  partialText?: string;
  timing?: ModelCallTiming;
  cause?: unknown;
}

export class ModelError extends Error {
  readonly category: ModelErrorCategory;
  readonly retryable: boolean;
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly partialText?: string;
  /**
   * Latency breakdown of the failed call. Mutable so the layer that detects
   * the failure can attach it to an error created elsewhere.
   */
  timing?: ModelCallTiming;
  override readonly cause?: unknown;

  constructor(message: string, options: ModelErrorOptions) {
    super(scrubSecrets(message));
    this.name = "ModelError";
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryAfterMs !== undefined)
      this.retryAfterMs = options.retryAfterMs;
    if (options.partialText !== undefined)
      this.partialText = options.partialText;
    if (options.timing !== undefined) this.timing = options.timing;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  serialize(): SerializedModelError {
    const result: SerializedModelError = {
      category: this.category,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.code !== undefined) result.code = this.code;
    if (this.status !== undefined) result.status = this.status;
    if (this.requestId !== undefined) result.requestId = this.requestId;
    if (this.retryAfterMs !== undefined)
      result.retryAfterMs = this.retryAfterMs;
    if (this.partialText !== undefined) result.partialText = this.partialText;
    if (this.timing !== undefined) result.timing = this.timing;
    return result;
  }
}

/**
 * True when the provider rejected the request because the model does not
 * accept the sampling parameters (temperature/top_p) it was sent, e.g.
 * OpenAI reasoning models with a reasoning effort other than "none"
 * ("Unsupported parameter: 'temperature' …"), or Anthropic extended
 * thinking, which gateways enable for a reasoning effort ("`temperature` may
 * only be set to 1 when thinking is enabled").
 */
export function isSamplingParameterUnsupportedError(error: unknown): boolean {
  const message = invalidRequestMessage(error);
  if (message === null || !mentionsSamplingParameter(message)) return false;
  return rejectsParameter(message) || THINKING_CONSTRAINT.test(message);
}

/**
 * True when the provider rejected the reasoning effort the request sent:
 * the field itself (reasoning_effort, reasoning.effort, output_config.effort),
 * e.g. OpenAI non-reasoning models ("Unsupported parameter:
 * 'reasoning_effort' …"), or its value, e.g. a model that accepts only other
 * efforts. A rejection that names a sampling parameter is attributed to that
 * parameter instead (isSamplingParameterUnsupportedError), for example
 * "temperature is not supported with reasoning effort".
 */
export function isReasoningEffortUnsupportedError(error: unknown): boolean {
  const message = invalidRequestMessage(error);
  if (
    message === null ||
    !message.includes("effort") ||
    mentionsSamplingParameter(message)
  ) {
    return false;
  }
  return rejectsParameter(message) || REJECTED_FIELD.test(message);
}

/**
 * True when the provider rejected the Chat Completions `max_tokens` field,
 * e.g. OpenAI reasoning models that require `max_completion_tokens`.
 */
export function isMaxTokensUnsupportedError(error: unknown): boolean {
  const message = invalidRequestMessage(error);
  if (message === null || !message.includes("max_tokens")) return false;
  return message.includes("max_completion_tokens") || rejectsParameter(message);
}

function invalidRequestMessage(error: unknown): string | null {
  return error instanceof ModelError && error.category === "invalid_request"
    ? error.message.toLowerCase()
    : null;
}

function rejectsParameter(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("unsupported") || lowerMessage.includes("not support")
  );
}

function mentionsSamplingParameter(lowerMessage: string): boolean {
  return lowerMessage.includes("temperature") || lowerMessage.includes("top_p");
}

/**
 * Anthropic extended-thinking constraints on sampling parameters, e.g.
 * "`temperature` may only be set to 1 when thinking is enabled" and
 * "`top_p` must be greater than or equal to 0.95 or unset when thinking is
 * enabled". Only counted together with a sampling parameter name.
 */
const THINKING_CONSTRAINT =
  /\b(?:when|while|with) (?:extended )?thinking (?:is )?enabled\b/;

/**
 * Wording of request-field rejections besides "unsupported": Azure-style
 * "Unrecognized request argument supplied", schema-validating gateways'
 * "Extra inputs are not permitted", and value rejections.
 */
const REJECTED_FIELD =
  /\bunrecognized\b|\bunknown (?:parameter|field|argument)\b|\bnot permitted\b|\bnot allowed\b|\binvalid value\b/;

export function scrubSecrets(input: string): string {
  let result = input;
  result = result.replace(SECRET_PATTERNS[0], "[REDACTED_KEY]");
  result = result.replace(SECRET_PATTERNS[1], "[REDACTED_KEY]");
  result = result.replace(SECRET_PATTERNS[2], "$1[REDACTED]");
  return result;
}

export function asModelError(error: unknown, partialText?: string): ModelError {
  if (error instanceof ModelError) {
    if (partialText && !error.partialText) {
      return new ModelError(error.message, {
        category: error.category,
        retryable: error.retryable,
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.requestId === undefined
          ? {}
          : { requestId: error.requestId }),
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs }),
        ...(error.timing === undefined ? {} : { timing: error.timing }),
        partialText,
        cause: error.cause,
      });
    }
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ModelError("Request cancelled", {
      category: "cancelled",
      code: "model.cancelled",
      ...(partialText === undefined ? {} : { partialText }),
      cause: error,
    });
  }
  return new ModelError(
    error instanceof Error ? error.message : String(error),
    {
      category: "network",
      retryable: true,
      ...(partialText === undefined ? {} : { partialText }),
      cause: error,
    },
  );
}
