import {
  CanonCandidateRunAcceptedSchema,
  CanonCandidateSetSchema,
  CanonSpreadSchema,
  CreateCanonCandidateRequestSchema,
  DecideCanonCandidateItemRequestSchema,
  DecideCanonCandidateItemResponseSchema,
} from "@narralume/contracts";
import { CanonCandidateService } from "@narralume/narrative";
import {
  SqliteProjectRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import {
  CanonCandidateRouteError,
  createCanonSpreadCandidateRun,
} from "./canon-candidate-run.js";
import type { RouteApp } from "./route-app.js";
import type { RunCoordinator } from "./run-coordinator.js";

const SpreadParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  spread: CanonSpreadSchema,
});
const CandidateParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  candidateSetId: z.string().trim().min(1),
});
const CandidateItemParamsSchema = CandidateParamsSchema.extend({
  itemId: z.string().trim().min(1),
});

export interface RegisterCanonCandidateRouteOptions {
  runCoordinator: RunCoordinator;
  enableBackgroundWorker: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}

export function registerCanonCandidateRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: RegisterCanonCandidateRouteOptions,
): void {
  const projects = new SqliteProjectRepository(database);
  const candidates = new CanonCandidateService(database);

  app.route(
    "POST",
    "/api/projects/:projectId/canon-spreads/:spread/candidates",
    async (request) => {
      const { projectId, spread } = SpreadParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = CreateCanonCandidateRequestSchema.parse(request.body);
      const accepted = createCanonSpreadCandidateRun(
        database,
        options.environment,
        {
          projectId,
          spread,
          requestId: input.requestId,
          instruction: input.instruction,
          now: new Date().toISOString(),
        },
      );
      if (!accepted.idempotentReplay && options.enableBackgroundWorker) {
        options.runCoordinator.wake();
      }
      return {
        status: 202,
        body: CanonCandidateRunAcceptedSchema.parse(accepted),
      };
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/canon-spreads/:spread/candidates",
    async (request) => {
      const { projectId, spread } = SpreadParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      return candidates
        .list(projectId, spread)
        .map((candidate) => CanonCandidateSetSchema.parse(candidate));
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/canon-candidates/:candidateSetId",
    async (request) => {
      const { projectId, candidateSetId } = CandidateParamsSchema.parse(
        request.params,
      );
      requireProject(projects, projectId);
      return CanonCandidateSetSchema.parse(
        candidates.get(projectId, candidateSetId),
      );
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/canon-candidates/:candidateSetId/items/:itemId/decisions",
    async (request) => {
      const { projectId, candidateSetId, itemId } =
        CandidateItemParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = DecideCanonCandidateItemRequestSchema.parse(request.body);
      return DecideCanonCandidateItemResponseSchema.parse(
        candidates.decideItem({
          projectId,
          changeSetId: candidateSetId,
          itemId,
          action: input.action,
          confirmLocked: input.confirmLocked,
        }),
      );
    },
  );
}

function requireProject(projects: SqliteProjectRepository, projectId: string) {
  const project = projects.get(projectId);
  if (!project)
    throw new CanonCandidateRouteError(
      "project.not_found",
      "Project not found",
      404,
    );
  return project;
}
