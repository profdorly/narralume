import type { HealthResponse } from "@lapis/contracts";

import { kernelRequest } from "../../kernel/kernel-client";
import { getLocale, translate, type MessageKey } from "../../i18n";
import { errors as catalogErrors } from "../../i18n/pt-BR/errors";
import { requireResolvedMode } from "../../kernel/transport";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return knownApiErrorMessage(error.code) ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return translate(getLocale(), "errors.message.requestFailed");
}

/**
 * Look up localized text in the dictionary by error code; returns null when the
 * dictionary has no entry for the code.
 */
export function knownApiErrorMessage(code: string): string | null {
  const key = errorLookupKey(`message.${errorCodeKey(code)}`);
  return key ? translate(getLocale(), key) : null;
}

/**
 * Convert a backend error code (request.unknown_field,
 * assignment.model_limits.required, etc.) to a camelCase dictionary key.
 */
function errorCodeKey(code: string): string {
  return code.replace(/[._-](\w)/g, (_sep, ch: string) => ch.toUpperCase());
}

/* Error messages are all looked up in the errors dictionary (pt-BR is the
   structural source of truth); keys are built from the code at runtime, so
   check existence before translating, to keep unknown codes from triggering
   translate's missing-key warning. */
function errorLookupKey(path: string): MessageKey | null {
  let node: unknown = catalogErrors;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? (`errors.${path}` as MessageKey) : null;
}

/**
 * Readable extra hint for a backend error code (probe failure stages etc. are
 * rendered separately from details).
 */
export function apiErrorHint(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "policy.unknown_field") {
    const fields = detailStringList(error.details, "fields");
    return fields.length
      ? translate(getLocale(), "errors.hint.policyUnknownFieldFields", {
          fields: fields.join(fieldSeparator()),
        })
      : translate(getLocale(), "errors.hint.policyUnknownField");
  }
  if (error.code === "request.unknown_field") {
    const fields = detailStringList(error.details, "fields");
    return fields.length
      ? translate(getLocale(), "errors.hint.requestUnknownFieldFields", {
          fields: fields.join(fieldSeparator()),
        })
      : translate(getLocale(), "errors.hint.requestUnknownField");
  }
  const key = errorLookupKey(`hint.${errorCodeKey(error.code)}`);
  return key ? translate(getLocale(), key) : null;
}

function fieldSeparator(): string {
  return ", ";
}

function detailStringList(details: unknown, key: string): string[] {
  if (!details || typeof details !== "object") return [];
  const value = (details as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health", signal ? { signal } : {});
}

export function jsonRequest(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown,
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/*
 * The low-level helpers dispatch through the dual-driver transport: server mode
 * uses a relative fetch (original behavior), local mode converts the request to
 * an HTTP shape for the browser kernel. The signatures of all exported
 * functions are unchanged.
 */

async function transportRequest(
  input: string,
  init: RequestInit,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const mode = await requireResolvedMode();
  if (mode === "local") {
    return kernelRequest({
      method: (init.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: input,
      body: init.body,
      headers: init.headers as Record<string, string> | undefined,
    });
  }
  const response = await fetch(input, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");
  return { status: response.status, headers, body };
}

function transportError(
  status: number,
  body: unknown,
): ApiError {
  const envelope =
    body && typeof body === "object" && "error" in body
      ? (body as { error: Record<string, unknown> }).error
      : null;
  const code =
    envelope && typeof envelope.code === "string"
      ? envelope.code
      : `http.${status}`;
  const message =
    envelope && typeof envelope.message === "string"
      ? envelope.message
      : translate(getLocale(), "errors.message.httpFailed", { status });
  let details: unknown = envelope?.details;
  if (details === undefined && envelope) {
    // The backend sometimes puts extra information directly in the error
    // envelope (e.g. fields:string[]); when there is no details field, keep
    // those remaining keys as they are.
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(envelope)) {
      if (key !== "code" && key !== "message" && key !== "requestId") {
        rest[key] = value;
      }
    }
    details = Object.keys(rest).length > 0 ? rest : undefined;
  }
  return new ApiError(code, message, status, details);
}

export async function requestJson<T>(input: string, init: RequestInit): Promise<T> {
  const response = await transportRequest(input, init);
  if (response.status >= 400)
    throw transportError(response.status, response.body);
  return response.body as T;
}

export async function requestVoid(input: string, init: RequestInit): Promise<void> {
  const response = await transportRequest(input, init);
  if (response.status >= 400)
    throw transportError(response.status, response.body);
}

/**
 * Raw binary download (export / skill package): in local mode, turn the
 * kernel's Uint8Array into a Blob.
 */
export async function requestBlob(
  input: string,
  init: RequestInit = {},
): Promise<{ blob: Blob; filename: string | null; contentType: string | null }> {
  const mode = await requireResolvedMode();
  if (mode === "local") {
    const response = await kernelRequest({
      method: (init.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: input,
      body: init.body,
      headers: init.headers as Record<string, string> | undefined,
    });
    if (response.status >= 400) {
      throw transportError(
        response.status,
        response.body && typeof response.body === "object" && "error" in response.body
          ? response.body
          : null,
      );
    }
    const disposition = response.headers["content-disposition"] ?? "";
    const encodedName =
      disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1] ?? null;
    return {
      blob: new Blob([response.body as BlobPart]),
      filename: encodedName ? decodeURIComponent(encodedName) : null,
      contentType: response.headers["content-type"] ?? null,
    };
  }
  const response = await fetch(input, init);
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw transportError(response.status, null);
    }
    throw transportError(response.status, body);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedName =
    disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1] ?? null;
  return {
    blob: await response.blob(),
    filename: encodedName ? decodeURIComponent(encodedName) : null,
    contentType: response.headers.get("content-type"),
  };
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const stride = 32_768;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

export async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
