import type { JsonSchemaContract, StructuredValidator } from "@lapis/llm";
import { z } from "zod";

export const SelectionEditResultSchema = z.object({
  replacementText: z.string().min(1).max(500_000),
  rationale: z.string().min(1).max(20_000),
  risk: z.enum(["low", "medium", "high"]),
});
export type SelectionEditResult = z.infer<typeof SelectionEditResultSchema>;

export const SELECTION_EDIT_CONTRACT: JsonSchemaContract = {
  name: "selection_edit",
  description: "A bounded replacement for an exact manuscript selection.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["replacementText", "rationale", "risk"],
    properties: {
      replacementText: { type: "string", minLength: 1 },
      rationale: { type: "string", minLength: 1 },
      risk: { type: "string", enum: ["low", "medium", "high"] },
    },
  },
};

export function collaborationValidator<T>(
  schema: z.ZodType<T>,
  semantic?: (value: T) => readonly string[],
): StructuredValidator<T> {
  return (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return {
        success: false,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
        ),
      };
    }
    const issues = semantic?.(parsed.data) ?? [];
    return issues.length > 0
      ? { success: false, issues: [...issues] }
      : { success: true, data: parsed.data };
  };
}
