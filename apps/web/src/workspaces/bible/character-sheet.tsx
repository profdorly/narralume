import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { ErrorNote } from "../../components/error-note";
import { useI18n, type MessageKey } from "../../i18n";
import {
  getKnowledgeEditor,
  updateCanonEntity,
  type StoryBible,
} from "../../lib/api";
import {
  acceptedFacts,
  attributeText,
  relationsForPerson,
  type DeskEntity,
  type DeskFact,
  type DeskOutlineNode,
  type DeskRelation,
} from "../studio/chapter-companion-model";

const BELIEF_LABEL: Record<string, MessageKey> = {
  known: "bible.sheets.belief.known",
  believed: "bible.sheets.belief.believed",
  suspected: "bible.sheets.belief.suspected",
  false_belief: "bible.sheets.belief.false_belief",
};

export function CharacterSheet({
  projectId,
  bible,
}: {
  projectId: string;
  bible: StoryBible;
}) {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const people = bible.entities.filter(
    (entity) => entity.type === "character" && entity.status !== "retired",
  );
  const requested = searchParams.get("person");
  const person =
    people.find((entity) => entity.id === requested) ?? people[0] ?? null;
  const facts = acceptedFacts(bible.facts as DeskFact[]).filter(
    (fact) => fact.subjectId === person?.id,
  );
  const relations = person
    ? relationsForPerson(
        bible.outline as DeskOutlineNode[],
        bible.relationships as DeskRelation[],
        bible.entities as DeskEntity[],
        person.id,
      )
    : [];
  const names = new Map(bible.entities.map((entity) => [entity.id, entity.name]));
  const knowledge = useQuery({
    queryKey: ["project", projectId, "knowledge-editor"],
    queryFn: ({ signal }) => getKnowledgeEditor(projectId, signal),
    enabled: Boolean(person),
  });
  const corrected = new Set(
    (knowledge.data?.corrections ?? []).map((item) => item.recordId),
  );
  const knows =
    knowledge.data?.records.filter(
      (record) =>
        record.knowerEntityId === person?.id && !corrected.has(record.id),
    ) ?? [];

  if (!person) {
    return <p className="studio__panel-empty">{t("bible.sheets.noPeople")}</p>;
  }

  return (
    <section className="story-lines" aria-label={t("bible.sheets.characterTitle")}>
      <div className="story-board__views">
        {people.map((entity) => (
          <button
            key={entity.id}
            type="button"
            className="btn"
            aria-pressed={entity.id === person.id}
            onClick={() =>
              setSearchParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  next.set("spread", "entities");
                  next.set("sheet", "character");
                  next.set("person", entity.id);
                  return next;
                },
                { replace: true },
              )
            }
          >
            {entity.name}
          </button>
        ))}
      </div>
      <h2>{person.name}</h2>
      <CharacterDescription key={person.id} projectId={projectId} person={person as DeskEntity} />
      <AttributeList person={person as DeskEntity} />
      <h3>{t("bible.sheets.facts")}</h3>
      {facts.length === 0 ? (
        <p className="studio__panel-empty">{t("bible.sheets.noFacts")}</p>
      ) : (
        <ul>
          {facts.map((fact) => (
            <li key={fact.id}>
              {fact.predicate}: {fact.value ?? names.get(fact.objectEntityId ?? "") ?? ""}
            </li>
          ))}
        </ul>
      )}
      <h3>{t("bible.sheets.relations")}</h3>
      {relations.length === 0 ? (
        <p className="studio__panel-empty">{t("bible.sheets.noRelations")}</p>
      ) : (
        <ul>
          {relations.map((relation) => {
            const otherId =
              relation.fromEntityId === person.id
                ? relation.toEntityId
                : relation.fromEntityId;
            return (
              <li key={`${relation.fromEntityId}-${relation.toEntityId}-${relation.relation}`}>
                {names.get(otherId) ?? otherId}: {relation.relation}
              </li>
            );
          })}
        </ul>
      )}
      <h3>{t("bible.sheets.knows")}</h3>
      {knowledge.isError ? (
        <ErrorNote error={knowledge.error} title={t("bible.sheets.knowsError")} />
      ) : knows.length === 0 ? (
        <p className="studio__panel-empty">{t("bible.sheets.knowsEmpty")}</p>
      ) : (
        <ul>
          {knows.map((record) => {
            const fact = bible.facts.find((item) => item.id === record.factId);
            const claim = fact
              ? `${fact.predicate}: ${fact.value ?? ""}`
              : record.timelineEventId;
            return (
              <li key={record.id}>
                {t(BELIEF_LABEL[record.belief] ?? "bible.sheets.belief.known")} — {claim}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AttributeList({ person }: { person: DeskEntity }) {
  const { t } = useI18n();
  const rows = [
    ["role", t("bible.sheets.role")],
    ["desire", t("bible.sheets.desire")],
    ["fear", t("bible.sheets.fear")],
  ] as const;
  const filled = rows.flatMap(([key, label]) => {
    const value = attributeText(person.attributes, key);
    return value ? [{ key, label, value }] : [];
  });
  if (filled.length === 0) return null;
  return (
    <ul>
      {filled.map((row) => (
        <li key={row.key}>
          {row.label}: {row.value}
        </li>
      ))}
    </ul>
  );
}

function CharacterDescription({
  projectId,
  person,
}: {
  projectId: string;
  person: DeskEntity;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(person.description ?? "");
  const save = useMutation({
    mutationFn: () =>
      updateCanonEntity(projectId, person.id, {
        name: person.name,
        aliases: person.aliases,
        description: description.trim() ? description.trim() : null,
        attributes: person.attributes,
        status: person.status === "retired" ? "retired" : "active",
        expectedUpdatedAt: person.updatedAt,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "bible"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "story-bible"],
      });
    },
  });
  return (
    <form
      className="story-line-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label>
        {t("bible.sheets.description")}
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <button type="submit" className="btn" disabled={save.isPending}>
        {t("bible.sheets.save")}
      </button>
      {save.isSuccess ? <p role="status">{t("bible.sheets.saved")}</p> : null}
      {save.isError ? (
        <ErrorNote error={save.error} title={t("bible.sheets.saveError")} />
      ) : null}
    </form>
  );
}
