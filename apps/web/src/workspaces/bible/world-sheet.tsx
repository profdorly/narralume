import { useI18n, type MessageKey } from "../../i18n";
import type { StoryBible } from "../../lib/api";
import {
  worldSections,
  type DeskEntity,
  type DeskFact,
} from "../studio/chapter-companion-model";

const GROUP_LABEL: Record<string, MessageKey> = {
  location: "bible.sheets.groups.location",
  organization: "bible.sheets.groups.organization",
  item: "bible.sheets.groups.item",
  rule: "bible.sheets.groups.rule",
  concept: "bible.sheets.groups.concept",
};

export function WorldSheet({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const names = new Map(bible.entities.map((entity) => [entity.id, entity.name]));
  const groups = worldSections(
    bible.entities as DeskEntity[],
    bible.facts as DeskFact[],
  );
  if (groups.length === 0) {
    return <p className="studio__panel-empty">{t("bible.sheets.worldEmpty")}</p>;
  }
  return (
    <section className="story-lines" aria-label={t("bible.sheets.worldTitle")}>
      {groups.map((group) => (
        <section key={group.type}>
          <h2>{t(GROUP_LABEL[group.type] ?? "bible.sheets.worldTitle")}</h2>
          {group.entries.map(({ entity, facts }) => (
            <article key={entity.id}>
              <h3>{entity.name}</h3>
              {entity.description ? <p>{entity.description}</p> : null}
              {facts.length > 0 ? (
                <ul>
                  {facts.map((fact) => (
                    <li key={fact.id}>
                      {fact.predicate}:{" "}
                      {fact.value ??
                        names.get(fact.objectEntityId ?? "") ??
                        ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </section>
      ))}
    </section>
  );
}
