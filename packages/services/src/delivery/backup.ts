import { randomUuid } from "@lapis/domain";
import type { BundleCounts } from "@lapis/contracts";
import {
  BundleSchema,
  DeliveryServiceError,
  buildBundle,
  hash,
  restoreBundle,
  type DeliveryContext,
} from "./bundle.js";

export function createBackup(
  ctx: DeliveryContext,
  projectId: string,
  label: string,
  now: string,
) {
  const bundle = buildBundle(ctx, projectId, now, {
    versionMode: "history",
    includeAnnotations: true,
    includeRuns: true,
  });
  const bundleJson = JSON.stringify(bundle);
  const backup = {
    id: randomUuid(),
    projectId,
    label,
    bundleHash: hash(bundleJson),
    sizeBytes: bundleJson.length,
    createdAt: now,
    restoredProjectId: null,
    counts: bundle.manifest.counts as Record<string, number>,
  };
  return ctx.delivery.insertBackup(backup, bundleJson);
}

export function restoreBackup(
  ctx: DeliveryContext,
  backupId: string,
  title: string | undefined,
  now: string,
) {
  const stored = ctx.delivery.getBackup(backupId);
  if (!stored)
    throw new DeliveryServiceError("backup.not_found", "Backup not found");
  if (hash(stored.bundleJson) !== stored.backup.bundleHash) {
    throw new DeliveryServiceError(
      "backup.integrity.failed",
      "Backup hash verification failed; the restore was not performed",
    );
  }
  const checked = BundleSchema.safeParse(JSON.parse(stored.bundleJson));
  if (!checked.success)
    throw new DeliveryServiceError(
      "import.bundle.invalid_schema",
      "The project bundle structure or version is not supported",
    );
  const bundle = checked.data;
  return ctx.database.transaction(() => {
    const { projectId, counts } = restoreBundle(
      ctx,
      bundle,
      title ?? `${bundle.project.title} · restauração`,
      now,
    );
    const expected = bundle.manifest.counts;
    // runs are exported in the bundle only as interrupted history and do not
    // resume in the restored copy, so they are not part of the count check.
    const mismatched = (Object.keys(expected) as (keyof BundleCounts)[])
      .filter((key) => key !== "runs")
      .filter((key) => counts[key] !== expected[key]);
    if (mismatched.length) {
      throw new DeliveryServiceError(
        "backup.restore.count_mismatch",
        `Restore count verification failed: ${mismatched.join(", ")}`,
      );
    }
    return {
      projectId,
      backup: ctx.delivery.markBackupRestored(backupId, projectId),
      counts,
    };
  });
}

export function duplicateProject(
  ctx: DeliveryContext,
  projectId: string,
  title: string | undefined,
  now: string,
) {
  const bundle = buildBundle(ctx, projectId, now);
  return ctx.database.transaction(
    () =>
      restoreBundle(
        ctx,
        bundle,
        title ?? `${bundle.project.title} · cópia`,
        now,
      ).projectId,
  );
}
