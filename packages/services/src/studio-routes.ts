import { randomUuid } from "@lapis/domain";

import {
  BackgroundRunCreatedSchema,
  CreateDocumentCommentRequestSchema,
  CreateSelectionEditRequestSchema,
  DecideEditProposalRequestSchema,
  DocumentCommentSchema,
  EditProposalSchema,
  SaveDocumentDraftRequestSchema,
  SetDocumentArchivedRequestSchema,
  StudioDocumentDetailSchema,
  UpdateDocumentCommentRequestSchema,
} from "@lapis/contracts";
import {
  CreativePersistenceError,
  SqliteCreativeRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteRequestReplayRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";
import { z } from "zod";

import type { RunCoordinator, RouteApp } from "@lapis/services";
import {
  acceptEditProposal,
  createSelectionEditRun,
  hashRequest,
  requireProject as requireStudioProject,
  runProductProjection,
} from "@lapis/services";
import { StudioRouteError } from "./route-error.js";

const ProjectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const DocumentParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
});
const CommentParamsSchema = z.object({ commentId: z.string().trim().min(1) });
const ProposalParamsSchema = z.object({ proposalId: z.string().trim().min(1) });
const StudioDocumentQuerySchema = z.object({
  includeArchived: z.coerce.boolean().default(false),
});

export function registerStudioRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: {
    coordinator: RunCoordinator;
    enableBackgroundWorker: boolean;
    environment: Readonly<Record<string, string | undefined>>;
    /** Wakes the Story Bible completion after a commit re-targeted it. */
    bibleBackfillWake?: () => void;
  },
): void {
  const creative = new SqliteCreativeRepository(database);
  const documents = new SqliteDocumentRepository(database);
  const projects = new SqliteProjectRepository(database);
  const requestReplays = new SqliteRequestReplayRepository(database);

  app.route(
    "GET",
    "/api/projects/:projectId/studio/documents",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireStudioProject(projects, projectId);
      const query = StudioDocumentQuerySchema.parse(request.query);
      return documents.list(projectId, undefined, query.includeArchived);
    },
  );

  app.route(
    "PUT",
    "/api/projects/:projectId/studio/documents/:documentId/archive",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = SetDocumentArchivedRequestSchema.parse(request.body);
      const current = documents.get(projectId, documentId);
      if (!current)
        throw new StudioRouteError(
          "document.not_found",
          "Document not found",
          404,
        );
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StudioRouteError(
          "document.version.conflict",
          "The document has changed; refresh before moving it",
          409,
        );
      return documents.setArchived(
        projectId,
        documentId,
        input.archived,
        input.expectedUpdatedAt,
        new Date().toISOString(),
      );
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/studio/documents/:documentId",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const document = documents.get(projectId, documentId);
      if (!document)
        throw new StudioRouteError(
          "document.not_found",
          "Document not found",
          404,
        );
      return StudioDocumentDetailSchema.parse({
        document,
        currentVersion: document.currentVersionId
          ? documents.getVersion(
              projectId,
              documentId,
              document.currentVersionId,
            )
          : null,
        draft: documents.getDraft(projectId, documentId),
        versions: documents.listVersions(projectId, documentId),
        comments: creative.listComments(documentId),
        proposals: creative.listEditProposals(documentId),
      });
    },
  );

  app.route(
    "PUT",
    "/api/projects/:projectId/studio/documents/:documentId/draft",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = SaveDocumentDraftRequestSchema.parse(request.body);
      const document = documents.get(projectId, documentId);
      if (!document)
        throw new StudioRouteError(
          "document.not_found",
          "Document not found",
          404,
        );
      if (input.baseVersionId !== document.currentVersionId) {
        throw new StudioRouteError(
          "draft.base_version.conflict",
          "The manuscript version has changed; refresh before saving the draft",
          409,
        );
      }
      const existingDraft = documents.getDraft(projectId, documentId);
      if ((existingDraft?.updatedAt ?? null) !== input.expectedDraftUpdatedAt) {
        throw new StudioRouteError(
          "draft.updated_at.conflict",
          "The draft was updated in another page; refresh before saving",
          409,
        );
      }
      const currentContent = document.currentVersionId
        ? (documents.getVersion(
            projectId,
            documentId,
            document.currentVersionId,
          )?.content ?? "")
        : "";
      if (input.content === currentContent) {
        documents.deleteDraft(projectId, documentId);
        return null;
      }
      return documents.upsertDraft(projectId, documentId, {
        baseVersionId: input.baseVersionId,
        content: input.content,
        now: new Date().toISOString(),
      });
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/studio/documents/:documentId/comments",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = CreateDocumentCommentRequestSchema.parse(request.body);
      const version = documents.getVersion(
        projectId,
        documentId,
        input.versionId,
      );
      if (!version)
        throw new StudioRouteError(
          "document.version.not_found",
          "The version referenced by the comment does not exist",
          404,
        );
      const now = new Date().toISOString();
      return {
        status: 201,
        body: DocumentCommentSchema.parse(
          creative.insertComment(
            {
              id: randomUuid(),
              projectId,
              documentId,
              versionId: input.versionId,
              startOffset: input.startOffset,
              endOffset: input.endOffset,
              quote: input.quote,
              body: input.body,
              status: "open",
              createdAt: now,
              updatedAt: now,
            },
            version.content,
          ),
        ),
      };
    },
  );

  app.route("PUT", "/api/studio/comments/:commentId", async (request) => {
    const { commentId } = CommentParamsSchema.parse(request.params);
    const input = UpdateDocumentCommentRequestSchema.parse(request.body);
    return DocumentCommentSchema.parse(
      creative.setCommentStatus(
        commentId,
        input.status,
        new Date().toISOString(),
      ),
    );
  });

  app.route(
    "POST",
    "/api/projects/:projectId/studio/documents/:documentId/selection-edits",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = CreateSelectionEditRequestSchema.parse(request.body);
      // Version/draft consistency checks and run creation live in the service
      // layer; a failure must not produce version side effects.
      const snapshot = createSelectionEditRun(database, {
        projectId,
        documentId,
        baseVersionId: input.baseVersionId,
        draftContentHash: input.draftContentHash,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        instruction: input.instruction,
        requestPolicy: input.policy,
        environment: options.environment,
      });
      wake(options);
      return {
        status: 202,
        body: BackgroundRunCreatedSchema.parse({
          ...snapshot,
          ...runProductProjection(snapshot),
        }),
      };
    },
  );

  app.route(
    "POST",
    "/api/studio/edit-proposals/:proposalId/actions",
    async (request) => {
      const { proposalId } = ProposalParamsSchema.parse(request.params);
      const input = DecideEditProposalRequestSchema.parse(request.body);
      return database.transaction(() => {
        const scope = `edit-proposal:${proposalId}:action`;
        const requestHash = hashRequest(input);
        const proposal = creative.requireEditProposal(proposalId);
        const replay = requestReplays.get(scope, input.requestId);
        if (replay) {
          if (replay.requestHash !== requestHash) {
            throw new StudioRouteError(
              "edit_proposal.idempotency_conflict",
              "The same requestId was already used for a different selection proposal adjudication",
              409,
            );
          }
          return EditProposalSchema.parse(replay.result);
        }

        if (proposal.status !== "proposed") {
          const sameDecision =
            (proposal.status === "accepted" && input.action === "accept") ||
            (proposal.status === "rejected" && input.action === "reject");
          if (!sameDecision) {
            throw new StudioRouteError(
              "edit_proposal.already_decided",
              `The selection proposal is already ${proposal.status}; cannot perform ${input.action}`,
              409,
            );
          }
          const result = EditProposalSchema.parse(proposal);
          requestReplays.insert({
            scope,
            requestId: input.requestId,
            requestHash,
            result,
            createdAt: new Date().toISOString(),
          });
          return result;
        }

        const now = new Date().toISOString();
        if (input.action === "reject") {
          const result = EditProposalSchema.parse(
            creative.decideEditProposal(proposalId, "rejected", null, now),
          );
          requestReplays.insert({
            scope,
            requestId: input.requestId,
            requestHash,
            result,
            createdAt: now,
          });
          return result;
        }
        // The full assembly of version append/retrieval chunks/outline
        // status/operation log/manual settlement lives in the service layer.
        const decided = acceptEditProposal(database, {
          proposal,
          now,
          environment: options.environment,
          coordinatorWake: () => wake(options),
          interruptRun: (runId, reason) =>
            options.coordinator.interrupt(runId, reason),
          ...(options.bibleBackfillWake
            ? { bibleBackfillWake: options.bibleBackfillWake }
            : {}),
        });
        const result = EditProposalSchema.parse(decided);
        requestReplays.insert({
          scope,
          requestId: input.requestId,
          requestHash,
          result,
          createdAt: now,
        });
        return result;
      });
    },
  );

  void CreativePersistenceError;
}

function wake(options: {
  coordinator: RunCoordinator;
  enableBackgroundWorker: boolean;
}) {
  if (options.enableBackgroundWorker) options.coordinator.wake();
}
