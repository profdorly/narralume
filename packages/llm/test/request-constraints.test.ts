import { describe, expect, it } from "vitest";

import {
  ModelError,
  ModelGateway,
  OpenAIChatAdapter,
  isMaxTokensUnsupportedError,
  isSamplingParameterUnsupportedError,
} from "../src/index.js";
import { jsonResponse } from "./helpers.js";

const TEMPERATURE_REJECTED =
  "Unsupported parameter: 'temperature' is not supported with this model.";
const MAX_TOKENS_REJECTED =
  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";

function invalidRequest(message: string): ModelError {
  return new ModelError(message, { category: "invalid_request", status: 400 });
}

describe("request constraint detectors", () => {
  it("detects models that reject sampling parameters", () => {
    expect(
      isSamplingParameterUnsupportedError(invalidRequest(TEMPERATURE_REJECTED)),
    ).toBe(true);
    expect(
      isSamplingParameterUnsupportedError(
        invalidRequest(
          "Unsupported parameter: 'top_p' is not supported with this model.",
        ),
      ),
    ).toBe(true);
    expect(
      isSamplingParameterUnsupportedError(
        invalidRequest(
          "Unsupported value: 'temperature' does not support 0 with this model.",
        ),
      ),
    ).toBe(true);

    // Other invalid requests, other categories and plain errors do not match.
    expect(
      isSamplingParameterUnsupportedError(
        invalidRequest("temperature must be between 0 and 2"),
      ),
    ).toBe(false);
    expect(
      isSamplingParameterUnsupportedError(invalidRequest(MAX_TOKENS_REJECTED)),
    ).toBe(false);
    expect(
      isSamplingParameterUnsupportedError(
        new ModelError(TEMPERATURE_REJECTED, { category: "server" }),
      ),
    ).toBe(false);
    expect(
      isSamplingParameterUnsupportedError(new Error(TEMPERATURE_REJECTED)),
    ).toBe(false);
  });

  it("detects Chat Completions models that reject max_tokens", () => {
    expect(
      isMaxTokensUnsupportedError(invalidRequest(MAX_TOKENS_REJECTED)),
    ).toBe(true);
    expect(
      isMaxTokensUnsupportedError(
        invalidRequest("max_tokens is not supported by this model"),
      ),
    ).toBe(true);

    expect(
      isMaxTokensUnsupportedError(
        invalidRequest(
          "max_tokens is too large: 900000. This model supports at most 128000 completion tokens.",
        ),
      ),
    ).toBe(false);
    expect(
      isMaxTokensUnsupportedError(invalidRequest(TEMPERATURE_REJECTED)),
    ).toBe(false);
    expect(
      isMaxTokensUnsupportedError(
        new ModelError(MAX_TOKENS_REJECTED, { category: "protocol" }),
      ),
    ).toBe(false);
    expect(isMaxTokensUnsupportedError(new Error(MAX_TOKENS_REJECTED))).toBe(
      false,
    );
  });

  it("classifies the provider 400 body as a detectable invalid request", async () => {
    const gateway = new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "secret",
        maxRetries: 0,
        fetch: async () =>
          jsonResponse(
            {
              error: {
                message: TEMPERATURE_REJECTED,
                type: "invalid_request_error",
                param: "temperature",
                code: "unsupported_parameter",
              },
            },
            400,
          ),
      }),
    );

    const error = await gateway
      .generate({
        model: "reasoner",
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ category: "invalid_request", status: 400 });
    expect(isSamplingParameterUnsupportedError(error)).toBe(true);
    expect(isMaxTokensUnsupportedError(error)).toBe(false);
  });
});
