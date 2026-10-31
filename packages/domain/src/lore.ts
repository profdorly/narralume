import type { IsoDateTime, ProjectId } from "./index.js";

// Lorebooks and lore entries belong to the retired co-creation feature. The
// types stay because existing libraries keep these rows and work bundles
// still export and import them.

export const LORE_SCOPES = ["project", "persona", "session"] as const;
export type LoreScope = (typeof LORE_SCOPES)[number];

export interface Lorebook {
  id: string;
  projectId: ProjectId;
  name: string;
  description: string | null;
  enabledGlobally: boolean;
  scanTurns: number;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface LoreEntry {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: readonly string[];
  constant: boolean;
  priority: number;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface LoreActivationCandidate {
  lorebook: Lorebook;
  entry: LoreEntry;
  scope: LoreScope;
  /** Project, Persona, or story-room id selected by `scope`. */
  scopeId: string;
}
