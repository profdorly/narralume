import { z } from "zod";

/**
 * Limits for the persona profile stored with each persona row. Co-creation
 * (which imported character cards into personas) is gone, but existing
 * libraries and work bundles still carry personas, and bundle import keeps
 * validating their profile with this schema.
 */
export const PERSONA_CARD_LIMITS = {
  aggregateTextChars: 250_000,
  profileTextChars: 30_000,
  exampleDialogueChars: 100_000,
  greetingChars: 30_000,
  greetings: 64,
  creatorNameChars: 200,
  creatorNotesChars: 30_000,
  creatorVersionChars: 200,
  tags: 100,
  tagChars: 100,
} as const;

const NullableProfileTextSchema = z
  .string()
  .max(PERSONA_CARD_LIMITS.profileTextChars)
  .nullable();
const GreetingSchema = z
  .string()
  .trim()
  .min(1)
  .max(PERSONA_CARD_LIMITS.greetingChars);
const TagSchema = z.string().trim().min(1).max(PERSONA_CARD_LIMITS.tagChars);

export const PersonaCardSourceFormatSchema = z.enum([
  "native",
  "character-card-v2",
  "character-card-v3",
]);

const PersonaCardProfileObjectSchema = z
  .object({
    personality: NullableProfileTextSchema,
    scenario: NullableProfileTextSchema,
    exampleDialogue: z
      .string()
      .max(PERSONA_CARD_LIMITS.exampleDialogueChars)
      .nullable(),
    greetings: z.array(GreetingSchema).max(PERSONA_CARD_LIMITS.greetings),
    creator: z
      .object({
        name: z.string().max(PERSONA_CARD_LIMITS.creatorNameChars).nullable(),
        notes: z.string().max(PERSONA_CARD_LIMITS.creatorNotesChars).nullable(),
        version: z
          .string()
          .max(PERSONA_CARD_LIMITS.creatorVersionChars)
          .nullable(),
        tags: z.array(TagSchema).max(PERSONA_CARD_LIMITS.tags),
      })
      .strict(),
    source: z
      .object({
        format: PersonaCardSourceFormatSchema,
        importedAt: z.string().datetime().nullable(),
      })
      .strict(),
  })
  .strict();

export const PersonaCardProfileSchema =
  PersonaCardProfileObjectSchema.superRefine((profile, context) => {
    enforceAggregateTextLimit(
      [
        profile.personality,
        profile.scenario,
        profile.exampleDialogue,
        ...profile.greetings,
        profile.creator.name,
        profile.creator.notes,
        profile.creator.version,
        ...profile.creator.tags,
      ],
      context,
    );
  });

export type PersonaCardProfileDto = z.infer<typeof PersonaCardProfileSchema>;

function enforceAggregateTextLimit(
  values: readonly (string | null | undefined)[],
  context: z.RefinementCtx,
): void {
  const total = values.reduce((sum, value) => sum + (value?.length ?? 0), 0);
  if (total <= PERSONA_CARD_LIMITS.aggregateTextChars) return;
  context.addIssue({
    code: "custom",
    message: `Retained card text can contain at most ${PERSONA_CARD_LIMITS.aggregateTextChars} characters`,
  });
}
