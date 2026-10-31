/* Collaboration conversations get their own model and reasoning tier settings:
   an empty modelId means follow the global writing assignment; an empty
   reasoningEffort means low (the assistant's existing default). */
export const migration037 = {
  version: 37,
  name: "assistant-conversation-settings",
  sql: `
    ALTER TABLE assistant_conversations
      ADD COLUMN settings_json TEXT
        CHECK (settings_json IS NULL OR json_valid(settings_json));
  `,
} as const;
