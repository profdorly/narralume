import { NodeNarrativeDatabase } from "@lapis/persistence/node";

import { readServerConfig } from "../apps/server/src/config.js";
import { seedExampleBook } from "./fixtures/example-book.js";

/* npm run seed:example — adds the Portuguese sample book "O Correio das
   Marés" to the library in NARRATIVE_DATA_DIR (default ./data). */
const config = readServerConfig();
const database = new NodeNarrativeDatabase(config.databasePath);
database.migrate();

const { projectId, created } = seedExampleBook(database);
database.close();
process.stdout.write(
  created
    ? `Livro de exemplo gravado: ${projectId}\nBanco: ${config.databasePath}\n`
    : `O livro de exemplo já existe: ${projectId}\n`,
);
