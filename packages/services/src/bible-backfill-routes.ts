import {
  BibleBackfillActionRequestSchema,
  BibleBackfillActionResponseSchema,
  CreateBibleBackfillRequestSchema,
} from "@narralume/contracts";
import type { NarrativeDatabase } from "@narralume/persistence";
import { z } from "zod";

import type { BibleBackfillCoordinator } from "./bible-backfill-coordinator.js";
import { BibleBackfillService } from "./bible-backfill-service.js";
import type { RouteApp } from "./route-app.js";
import type { RunCoordinator } from "./run-coordinator.js";

const ProjectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const JobParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  jobId: z.string().trim().min(1),
});

export interface RegisterBibleBackfillRouteOptions {
  coordinator: BibleBackfillCoordinator;
  runCoordinator: RunCoordinator;
  enableBackgroundWorker: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}

/** 「从正文补全故事圣经」：建任务、读进度、作者控制。 */
export function registerBibleBackfillRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: RegisterBibleBackfillRouteOptions,
): void {
  const service = new BibleBackfillService(database, options.environment);
  const wake = () => {
    if (!options.enableBackgroundWorker) return;
    options.runCoordinator.wake();
    options.coordinator.wake();
  };

  app.route(
    "POST",
    "/api/projects/:projectId/bible-backfills",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const input = CreateBibleBackfillRequestSchema.parse(request.body);
      const created = service.create(
        projectId,
        input,
        new Date().toISOString(),
      );
      if (!created.idempotentReplay) wake();
      return { status: 202, body: created };
    },
  );

  // Registered before /:jobId: the kernel route table matches in order.
  app.route(
    "GET",
    "/api/projects/:projectId/bible-backfills/current",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      return service.current(projectId);
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/bible-backfills/:jobId",
    async (request) => {
      const { projectId, jobId } = JobParamsSchema.parse(request.params);
      return service.detail(projectId, jobId);
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/bible-backfills/:jobId/actions",
    async (request) => {
      const { projectId, jobId } = JobParamsSchema.parse(request.params);
      const input = BibleBackfillActionRequestSchema.parse(request.body);
      const result = service.act(
        projectId,
        jobId,
        input,
        new Date().toISOString(),
      );
      if (result.interruptRunId) {
        options.runCoordinator.interrupt(
          result.interruptRunId,
          "bible_backfill_cancelled",
        );
      }
      if (!result.idempotentReplay) wake();
      return BibleBackfillActionResponseSchema.parse({
        ...result.detail,
        idempotentReplay: result.idempotentReplay,
      });
    },
  );

  /** Advances one persisted transition synchronously (tests, diagnostics). */
  app.route(
    "POST",
    "/api/projects/:projectId/bible-backfills/:jobId/advance",
    async (request) => {
      const { projectId, jobId } = JobParamsSchema.parse(request.params);
      service.detail(projectId, jobId);
      const processed = await options.coordinator.advanceJob(jobId);
      return { processed, detail: service.detail(projectId, jobId) };
    },
  );
}
