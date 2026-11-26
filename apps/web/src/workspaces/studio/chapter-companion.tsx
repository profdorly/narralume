import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";

import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import { projectWorkspacePath } from "../../lib/project-route";
import {
  createDocumentReview,
  getStoryBible,
  updateOutlineNode,
  type ReviewWorkspace,
  type StoryDocument,
} from "../../lib/api";
import {
  buildChapterCompanion,
  type DeskEntity,
  type DeskFact,
  type DeskOutlineNode,
  type DeskRelation,
  type DeskThread,
} from "./chapter-companion-model";

export function ChapterCompanion({
  projectId,
  document,
  prose,
  review,
  onOpenSelection,
  onOpenChanges,
}: {
  projectId: string;
  document: StoryDocument;
  prose: string;
  review: ReviewWorkspace | undefined;
  onOpenSelection: () => void;
  onOpenChanges: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const checkRequest = useRef<{ versionId: string; requestId: string } | null>(
    null,
  );
  const story = useQuery({
    queryKey: ["project", projectId, "story-bible"],
    queryFn: ({ signal }) => getStoryBible(projectId, signal),
  });
  const check = useMutation({
    mutationFn: () => {
      if (!document.currentVersionId) {
        throw new Error(t("studio.companion.checkNeedsVersion"));
      }
      if (checkRequest.current?.versionId !== document.currentVersionId) {
        checkRequest.current = {
          versionId: document.currentVersionId,
          requestId: crypto.randomUUID(),
        };
      }
      return createDocumentReview(projectId, document.id, {
        requestId: checkRequest.current.requestId,
        documentVersionId: document.currentVersionId,
        origin: { surface: "writing", documentId: document.id },
      });
    },
    onSuccess: () => {
      checkRequest.current = null;
      setNotice(t("studio.companion.checkStarted"));
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "review"],
      });
    },
  });
  const register = useMutation({
    mutationFn: (node: DeskOutlineNode) =>
      updateOutlineNode(projectId, node.id, {
        status: "committed",
        expectedUpdatedAt: node.updatedAt,
      }),
    onSuccess: () => {
      setNotice(t("studio.companion.registered"));
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "story-bible"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "bible"],
      });
    },
  });

  if (document.kind !== "chapter" || !document.outlineNodeId) {
    return <p className="studio__panel-empty">{t("studio.companion.empty")}</p>;
  }
  if (story.isPending) return <Skeleton lines={6} />;
  if (story.isError) {
    return (
      <ErrorNote error={story.error} title={t("studio.companion.loadError")} />
    );
  }

  const bible = story.data;
  const model = buildChapterCompanion({
    outlineNodeId: document.outlineNodeId,
    prose,
    outline: bible.outline as DeskOutlineNode[],
    entities: bible.entities as DeskEntity[],
    facts: bible.facts as DeskFact[],
    relations: bible.relationships as DeskRelation[],
    threads: bible.foreshadows as DeskThread[],
  });
  const findings = (review?.reports ?? [])
    .filter(
      (report) =>
        report.documentId === document.id &&
        report.documentVersionId === document.currentVersionId,
    )
    .flatMap((report) => report.issues)
    .filter(
      (issue) =>
        issue.status === "open" &&
        ["continuity", "canon", "character", "foreshadow"].includes(
          issue.category,
        ),
    );
  const places = model.cast.filter((entity) => entity.type !== "character");
  const people = model.cast.filter((entity) => entity.type === "character");

  const sheetPath = (personId: string) =>
    `${projectWorkspacePath(projectId, "bible")}?spread=entities&sheet=character&person=${encodeURIComponent(personId)}`;

  return (
    <div>
      <p className="studio__section-intro">{t("studio.companion.intro")}</p>
      <div className="studio__desk-actions">
        <button type="button" className="btn" onClick={onOpenSelection}>
          {t("studio.companion.rewrite")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={check.isPending || !document.currentVersionId}
          onClick={() => check.mutate()}
        >
          {check.isPending
            ? t("studio.companion.checking")
            : t("studio.companion.check")}
        </button>
      </div>
      {!document.currentVersionId ? (
        <p className="studio__panel-empty">
          {t("studio.companion.checkNeedsVersion")}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {check.isError ? (
        <ErrorNote error={check.error} title={t("studio.companion.checkError")} />
      ) : null}

      {model.contradictions.length > 0 ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.contradictions")}</h3>
          <ul>
            {model.contradictions.map((item) => (
              <li key={`${item.entityName}-${item.found}`}>
                {t("studio.companion.contradiction", {
                  name: item.entityName,
                  found: item.found,
                  accepted: item.accepted,
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {findings.length > 0 ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.reviewFindings")}</h3>
          <ul>
            {findings.map((issue) => (
              <li key={issue.id}>{issue.message}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {model.chapter?.goal ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.goal")}</h3>
          <p>{model.chapter.goal}</p>
        </section>
      ) : null}

      {model.previous ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.previous")}</h3>
          <p>{model.previous.title}</p>
          <p>{model.previous.summary ?? t("studio.companion.noSummary")}</p>
        </section>
      ) : null}

      {people.length > 0 ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.people")}</h3>
          <ul>
            {people.map((person) => (
              <li key={person.id}>
                <Link to={sheetPath(person.id)}>{person.name}</Link>
                {person.description ? <span> — {person.description}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="studio__panel-empty">{t("studio.companion.noCast")}</p>
      )}

      {places.length > 0 ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.places")}</h3>
          <ul>
            {places.map((place) => (
              <li key={place.id}>
                {place.name}
                {place.description ? ` — ${place.description}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {model.facts.length > 0 ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.facts")}</h3>
          <ul>
            {model.facts.map((fact) => (
              <li key={fact.id}>
                {t("studio.companion.factLine", {
                  name: fact.subjectName,
                  predicate: fact.predicate,
                  value: fact.value ?? fact.objectName ?? fact.predicate,
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {model.relations.length > 0 ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.relations")}</h3>
          <ul>
            {model.relations.map((relation) => (
              <li key={relation.id ?? `${relation.fromEntityId}-${relation.toEntityId}-${relation.relation}`}>
                {t("studio.companion.relationLine", {
                  from: relation.fromName,
                  to: relation.toName,
                  relation: relation.relation,
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {model.threads.length > 0 ? (
        <section>
          <h3 className="studio__panel-title">{t("studio.companion.threads")}</h3>
          <ul>
            {model.threads.map((thread) => (
              <li key={thread.id}>
                <strong>{thread.title}</strong>
                {thread.description ? ` — ${thread.description}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="studio__panel-title">{t("studio.companion.closeTitle")}</h3>
        <p>{t("studio.companion.closeChanges")}</p>
        <button type="button" className="btn" onClick={onOpenChanges}>
          {t("studio.companion.closeGo")}
        </button>
        {model.threads.length > 0 ? (
          <p>{t("studio.companion.closeOpen", { count: model.threads.length })}</p>
        ) : null}
        {model.chapter && !model.registered && document.currentVersionId ? (
          <button
            type="button"
            className="btn"
            disabled={register.isPending}
            onClick={() => {
              if (model.chapter) register.mutate(model.chapter);
            }}
          >
            {t("studio.companion.register")}
          </button>
        ) : model.registered ? (
          <p>{t("studio.companion.registered")}</p>
        ) : null}
        {register.isError ? (
          <ErrorNote
            error={register.error}
            title={t("studio.companion.registerError")}
          />
        ) : null}
      </section>
    </div>
  );
}
