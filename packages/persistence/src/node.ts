/**
 * Node-only entry point: NodeNarrativeDatabase (node:sqlite + VACUUM INTO
 * backup). Browsers use ./browser; the main entry point no longer carries any
 * node: built-in dependency.
 */
export { NodeNarrativeDatabase } from "./node-database.js";
