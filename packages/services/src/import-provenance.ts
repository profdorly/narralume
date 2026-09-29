import type { SqliteDeliveryRepository } from "@narralume/persistence";

/**
 * Whether a record whose source id is `sourceId` was created by applying an
 * import candidate of `candidateKind` from this project's manuscript import.
 */
export function isImportDerivedSource(
  deliveries: SqliteDeliveryRepository,
  projectId: string,
  candidateKind: string,
  sourceId: string | null,
): boolean {
  if (!sourceId) return false;
  const candidate = deliveries.getImportCandidate(sourceId);
  if (candidate?.kind !== candidateKind || candidate.status !== "applied") {
    return false;
  }
  const batch = deliveries.getImportBatch(candidate.batchId);
  return (batch?.appliedProjectId ?? batch?.targetProjectId) === projectId;
}
