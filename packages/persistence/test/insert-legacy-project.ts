import type { Project } from "@narralume/domain";

import {
  SqliteProjectRepository,
  type NarrativeDatabase,
} from "../src/index.js";

/** Insert a project whether or not migration 048 (`form`) has run. */
export function insertLegacyProject(
  database: NarrativeDatabase,
  project: Project,
): void {
  const hasForm = (
    database.raw.prepare("PRAGMA table_info(projects)").all() as {
      name: string;
    }[]
  ).some((column) => column.name === "form");
  if (hasForm) {
    new SqliteProjectRepository(database).insert(project);
    return;
  }
  database.raw
    .prepare(
      `INSERT INTO projects(
         id, title, subtitle, premise, language, phase, archived_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      project.title,
      project.subtitle,
      project.premise,
      project.language,
      project.phase,
      project.archivedAt,
      project.createdAt,
      project.updatedAt,
    );
}
