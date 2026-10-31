import { randomUuid, sha256Hex } from "@lapis/domain";

/**
 * Single synchronous sha256 entry point. Service-layer payloads are all
 * KB-sized JSON and short ID strings; the pure-JS implementation in domain
 * works in both Node and browser Workers.
 */
export { randomUuid, sha256Hex };
