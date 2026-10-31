import { PERSONA_CARD_LIMITS, PersonaCardProfileSchema } from "../src/index.js";
import { describe, expect, it } from "vitest";

// Persona rows and work bundles still carry this profile; bundle import
// validates it with PersonaCardProfileSchema.
describe("persona profile contract", () => {
  it("enforces profile field, collection, and aggregate text limits", () => {
    const exactAggregate = {
      ...nativeProfile(),
      personality: "p".repeat(PERSONA_CARD_LIMITS.profileTextChars),
      scenario: "s".repeat(PERSONA_CARD_LIMITS.profileTextChars),
      exampleDialogue: "e".repeat(PERSONA_CARD_LIMITS.exampleDialogueChars),
      greetings: Array.from({ length: 3 }, () =>
        "g".repeat(PERSONA_CARD_LIMITS.greetingChars),
      ),
    };

    expect(PersonaCardProfileSchema.safeParse(exactAggregate).success).toBe(
      true,
    );
    expect(
      PersonaCardProfileSchema.safeParse({
        ...exactAggregate,
        creator: { ...exactAggregate.creator, tags: ["x"] },
      }).success,
    ).toBe(false);
    expect(
      PersonaCardProfileSchema.safeParse({
        ...nativeProfile(),
        greetings: Array.from(
          { length: PERSONA_CARD_LIMITS.greetings + 1 },
          () => "你好",
        ),
      }).success,
    ).toBe(false);
    expect(
      PersonaCardProfileSchema.safeParse({
        ...nativeProfile(),
        personality: "p".repeat(PERSONA_CARD_LIMITS.profileTextChars + 1),
      }).success,
    ).toBe(false);
  });
});

function nativeProfile() {
  return {
    personality: null,
    scenario: null,
    exampleDialogue: null,
    greetings: [] as string[],
    creator: {
      name: null,
      notes: null,
      version: null,
      tags: [] as string[],
    },
    source: {
      format: "native" as const,
      importedAt: null,
    },
  };
}
