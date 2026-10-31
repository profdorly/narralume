import { describe, expect, it } from "vitest";

import { NodeNarrativeDatabase } from "@lapis/persistence/node";
import {
  SqliteModelRepository,
  SqliteProviderRepository,
} from "@lapis/persistence";

import { seedEnvironmentModelConfig } from "../src/model-config.js";

/* Environment seeding must not carry probe evidence across a re-point. */

const FIRST_START = "2026-09-01T00:00:00.000Z";
const NEXT_START = "2026-09-02T00:00:00.000Z";

const BASE_ENVIRONMENT = {
  NARRATIVE_CHAT_API_KEY: "placeholder",
  NARRATIVE_CHAT_BASE_URL: "https://first.example.test/v1",
  NARRATIVE_CHAT_MODEL: "first-model",
};

const PROBED_FLAGS = {
  streaming: true,
  tools: false,
  structuredOutput: true,
  structuredOutputNative: false,
  structuredOutputJsonMode: true,
  samplingParameters: false,
  maxCompletionTokens: true,
};

function seededDatabase() {
  const database = new NodeNarrativeDatabase();
  database.migrate();
  seedEnvironmentModelConfig(database, BASE_ENVIRONMENT, FIRST_START);
  const models = new SqliteModelRepository(database);
  const environmentModel = models.get("environment-chat");
  if (!environmentModel) throw new Error("environment model missing");
  // Probe evidence plus one flag the probe never writes.
  models.upsert({
    ...environmentModel,
    capabilities: { ...PROBED_FLAGS, vision: true },
  });
  models.upsert({
    ...environmentModel,
    id: "manual-sibling",
    modelId: "sibling-model",
    metadataSource: "manual",
    capabilities: { ...PROBED_FLAGS, vision: true },
  });
  return {
    database,
    models,
    providers: new SqliteProviderRepository(database),
  };
}

describe("seedEnvironmentModelConfig probe flags", () => {
  it("keeps probe flags when the environment is unchanged", () => {
    const { database, models } = seededDatabase();
    seedEnvironmentModelConfig(database, BASE_ENVIRONMENT, NEXT_START);

    expect(models.get("environment-chat")?.capabilities).toEqual({
      ...PROBED_FLAGS,
      vision: true,
    });
    expect(models.get("manual-sibling")?.capabilities).toEqual({
      ...PROBED_FLAGS,
      vision: true,
    });
  });

  it("clears only the re-pointed model's probe flags when the model id changes", () => {
    const { database, models } = seededDatabase();
    seedEnvironmentModelConfig(
      database,
      { ...BASE_ENVIRONMENT, NARRATIVE_CHAT_MODEL: "second-model" },
      NEXT_START,
    );

    const environmentModel = models.get("environment-chat");
    expect(environmentModel?.modelId).toBe("second-model");
    expect(environmentModel?.capabilities).toEqual({ vision: true });
    expect(environmentModel?.updatedAt).toBe(NEXT_START);
    expect(models.get("manual-sibling")?.capabilities).toEqual({
      ...PROBED_FLAGS,
      vision: true,
    });
  });

  it("clears probe flags of every model under the provider when the base URL changes", () => {
    const { database, models, providers } = seededDatabase();
    seedEnvironmentModelConfig(
      database,
      {
        ...BASE_ENVIRONMENT,
        NARRATIVE_CHAT_BASE_URL: "https://second.example.test/v1",
      },
      NEXT_START,
    );

    expect(providers.get("environment-chat")?.baseUrl).toBe(
      "https://second.example.test/v1",
    );
    for (const id of ["environment-chat", "manual-sibling"]) {
      const model = models.get(id);
      expect(model?.capabilities).toEqual({ vision: true });
      expect(model?.updatedAt).toBe(NEXT_START);
    }
  });

  it("clears probe flags when seeding restores the provider's wire API", () => {
    const { database, models, providers } = seededDatabase();
    const provider = providers.get("environment-chat");
    if (!provider) throw new Error("environment provider missing");
    providers.upsert({ ...provider, wireApi: "openai-responses" });

    seedEnvironmentModelConfig(database, BASE_ENVIRONMENT, NEXT_START);

    expect(providers.get("environment-chat")?.wireApi).toBe("openai-chat");
    for (const id of ["environment-chat", "manual-sibling"]) {
      expect(models.get(id)?.capabilities).toEqual({ vision: true });
    }
  });
});
