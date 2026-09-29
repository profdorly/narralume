import { describe, expect, it } from "vitest";

import {
  ModelError,
  ModelGateway,
  OpenAIChatAdapter,
  isMaxTokensUnsupportedError,
  isReasoningEffortUnsupportedError,
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

  it("detects extended-thinking constraints on sampling parameters", () => {
    // Gateways that map a reasoning effort to Anthropic extended thinking
    // pass these rejections on.
    for (const message of [
      "`temperature` may only be set to 1 when thinking is enabled. Please consult our documentation at https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking",
      "`top_p` must be greater than or equal to 0.95 or unset when thinking is enabled.",
      "temperature must be 1 with thinking enabled",
    ]) {
      expect(isSamplingParameterUnsupportedError(invalidRequest(message))).toBe(
        true,
      );
    }

    // Thinking constraints on other fields and unrelated sampling errors are
    // not sampling rejections.
    for (const message of [
      "`max_tokens` must be greater than `thinking.budget_tokens`",
      "`top_k` may only be set when thinking is disabled",
      "thinking.budget_tokens: Input should be greater than or equal to 1024",
      "temperature: Input should be less than or equal to 1",
      "`temperature` and `top_p` cannot both be specified for this model.",
    ]) {
      expect(isSamplingParameterUnsupportedError(invalidRequest(message))).toBe(
        false,
      );
    }
    expect(
      isSamplingParameterUnsupportedError(
        new ModelError(
          "`temperature` may only be set to 1 when thinking is enabled.",
          { category: "server" },
        ),
      ),
    ).toBe(false);
  });

  it("detects rejections of the reasoning effort field or value", () => {
    for (const message of [
      "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
      "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      "Unsupported value: 'reasoning_effort' does not support 'low' with this model. Supported values are: 'high'.",
      "Unrecognized request argument supplied: reasoning_effort",
      "output_config.effort: Extra inputs are not permitted",
      "Invalid value for reasoning effort: 'low'",
    ]) {
      expect(isReasoningEffortUnsupportedError(invalidRequest(message))).toBe(
        true,
      );
    }

    for (const message of [
      // Attributed to the sampling parameter it names.
      "Unsupported parameter: 'temperature' is not supported with reasoning effort 'low'.",
      TEMPERATURE_REJECTED,
      MAX_TOKENS_REJECTED,
      // Names the effort without rejecting it.
      "reasoning_effort must be one of 'low', 'medium', 'high'",
      "Your request was rejected; the effort to process it failed",
    ]) {
      expect(isReasoningEffortUnsupportedError(invalidRequest(message))).toBe(
        false,
      );
    }
    const fieldRejected =
      "Unsupported parameter: 'reasoning_effort' is not supported with this model.";
    expect(
      isReasoningEffortUnsupportedError(
        new ModelError(fieldRejected, { category: "server" }),
      ),
    ).toBe(false);
    expect(isReasoningEffortUnsupportedError(new Error(fieldRejected))).toBe(
      false,
    );
    expect(
      isSamplingParameterUnsupportedError(invalidRequest(fieldRejected)),
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
