import type { RouteApp } from "@narralume/services";
import {
  DecidePredictionRequestSchema,
  DryRunRequestSchema,
  DryRunResultSchema,
  GeneratePredictionsRequestSchema,
  NarrativeMemorySchema,
  PlotPredictionSchema,
  RetrievalHitSchema,
  RetrievalIndexStatusSchema,
  RetrievalReindexResultSchema,
  RetrievalSearchRequestSchema,
} from "@narralume/contracts";
import {
  SqliteAssignmentRepository,
  SqliteLongNovelRepository,
  SqliteManuscriptIndexer,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import { ServiceError } from "./service-error.js";

const ProjectParamsSchema = z.object({ projectId: z.string().min(1) });
const PredictionParamsSchema = ProjectParamsSchema.extend({
  predictionId: z.string().min(1),
});
const MemoryQuerySchema = z.object({
  includeStale: z.coerce.boolean().default(false),
});

export function registerLongNovelRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
): void {
  const retrieval = new SqliteRetrievalRepository(database);
  const indexer = new SqliteManuscriptIndexer(database);
  const longNovel = new SqliteLongNovelRepository(database);
  const projects = new SqliteProjectRepository(database);
  const assignments = new SqliteAssignmentRepository(database);

  const requireProject = (projectId: string) => {
    if (!projects.get(projectId))
      throw new ServiceError("project.not_found", "Project not found", 404);
  };
  const indexStatus = (projectId: string) => {
    const status = indexer.status(projectId);
    const assigned = assignments.resolve("embedding");
    const currentModel = assigned?.model.modelId ?? null;
    return RetrievalIndexStatusSchema.parse({
      documents: status.documents,
      indexedDocuments: status.indexedDocuments,
      passages: status.passages,
      legacySegments: status.legacySegments,
      embeddedPassages: status.embeddings.embedded,
      embeddingModel: assigned
        ? {
            id: assigned.model.id,
            modelId: assigned.model.modelId,
            providerName: assigned.provider.name,
          }
        : null,
      currentModelPassages: currentModel
        ? (status.embeddings.models.find(
            (entry) => entry.model === currentModel,
          )?.segments ?? 0)
        : 0,
      models: status.embeddings.models,
    });
  };

  app.route(
    "POST",
    "/api/projects/:projectId/retrieval/search",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const input = RetrievalSearchRequestSchema.parse(request.body);
      // Searches see edits made since the last AI run (passages and links;
      // vectors are added by the next run that has an embedding model).
      if (projects.get(projectId))
        indexer.syncProject(projectId, new Date().toISOString());
      return retrieval
        .search(projectId, input.query, {
          entityIds: input.entityIds,
          limit: input.limit,
          rerank: input.rerank,
          ...(input.maxPerDocument
            ? { maxPerDocument: input.maxPerDocument }
            : {}),
        })
        .map((hit) => RetrievalHitSchema.parse(hit));
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/retrieval/index",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projectId);
      return indexStatus(projectId);
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/retrieval/reindex",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projectId);
      const result = indexer.syncProject(projectId, new Date().toISOString());
      return RetrievalReindexResultSchema.parse({
        ...result,
        status: indexStatus(projectId),
      });
    },
  );

  app.route("GET", "/api/projects/:projectId/memories", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = MemoryQuerySchema.parse(request.query);
    return longNovel
      .listMemories(projectId, input)
      .map((memory) => NarrativeMemorySchema.parse(memory));
  });

  app.route(
    "POST",
    "/api/projects/:projectId/memories/rebuild",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      return longNovel
        .rebuildMemories(projectId, new Date().toISOString())
        .map((memory) => NarrativeMemorySchema.parse(memory));
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/memories/sleep",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const memory = longNovel.consolidateSleep(
        projectId,
        new Date().toISOString(),
      );
      return memory ? NarrativeMemorySchema.parse(memory) : null;
    },
  );

  app.route("GET", "/api/projects/:projectId/predictions", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return longNovel
      .listPredictions(projectId)
      .map((prediction) => PlotPredictionSchema.parse(prediction));
  });

  app.route("POST", "/api/projects/:projectId/predictions", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = GeneratePredictionsRequestSchema.parse(request.body);
    return longNovel
      .generatePredictions(projectId, input, new Date().toISOString())
      .map((prediction) => PlotPredictionSchema.parse(prediction));
  });

  app.route(
    "PUT",
    "/api/projects/:projectId/predictions/:predictionId",
    async (request) => {
      const { projectId, predictionId } = PredictionParamsSchema.parse(
        request.params,
      );
      const input = DecidePredictionRequestSchema.parse(request.body);
      return PlotPredictionSchema.parse(
        longNovel.decidePrediction(
          projectId,
          predictionId,
          input.status,
          new Date().toISOString(),
        ),
      );
    },
  );

  app.route("POST", "/api/projects/:projectId/dry-run", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = DryRunRequestSchema.parse(request.body);
    return DryRunResultSchema.parse(longNovel.dryRun(projectId, input.change));
  });
}
