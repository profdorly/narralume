import { randomUUID } from "node:crypto";

import {
  createCanonEntity,
  createCanonFact,
  createDefaultPersonaCardProfile,
  createDocument,
  createOutlineNode,
  createProject,
  transitionProjectPhase,
} from "@lapis/domain";
import {
  SqliteCanonRepository,
  SqliteCreativeRepository,
  SqliteDeliveryRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

export const EXAMPLE_PROJECT_ID = "example-tidal-post-office";

const CHAPTER_ONE = [
  "Inês segurou a carta em branco acima da lamparina a querosene e não a abriu de imediato. Primeiro deixou um pires de sal grosso no canto da mesa e prendeu a borda do envelope com uma pinça de cobre.",
  "Quando o calor atravessou as fibras do papel, o sal não derreteu: foi se acumulando, devagar, ao longo de um traço que ninguém tinha visto. O sobrenome do destinatário apareceu primeiro: Valadares.",
  "Ela tentou lembrar como a irmã baixava o pulso ao escrever e só encontrou um espaço limpo, em branco. O preço já tinha sido pago.",
  "Lá fora, a maré começava a voltar. Inês guardou a carta entre duas folhas de mata-borrão, anotou a hora no caderno — 23h19 — e apagou a lamparina antes que a tentação de ler o resto ficasse maior que o medo.",
].join("\n\n");

/** Portuguese sample book: intent, outline, canon, prose, story state, a
 *  narrator, a style profile and a writing skill. Idempotent by project id. */
export function seedExampleBook(
  database: NarrativeDatabase,
  now = new Date().toISOString(),
): { projectId: string; created: boolean } {
  const projectId = EXAMPLE_PROJECT_ID;
  const projects = new SqliteProjectRepository(database);
  if (projects.get(projectId)) return { projectId, created: false };

  database.transaction(() => {
    let project = projects.insert(
      createProject({
        id: projectId,
        title: "O Correio das Marés",
        subtitle: "Livro de exemplo",
        premise:
          "Um correio que só abre na maré baixa entrega cartas nunca enviadas antes que a lembrança delas se apague; a cada carta entregue, quem a escreveu perde uma memória ligada a ela.",
        language: "pt-BR",
        now,
      }),
    );
    for (const phase of ["foundation", "outlining", "writing"] as const) {
      project = projects.update(transitionProjectPhase(project, phase, now));
    }

    const story = new SqliteStoryRepository(database);
    story.upsertAuthorIntent({
      projectId,
      promise:
        "Cada lembrança recuperada cobra das personagens um preço visível e irreversível.",
      themes: ["memória e responsabilidade", "perda e testemunho"],
      audience:
        "Leitores adultos de fantasia de mistério movida por personagens",
      tone: "Contido, úmido, com peso de prova material",
      boundaries: [
        "Nada de ressurreição sem custo",
        "O narrador não explica as regras sobrenaturais",
      ],
      endingDirection:
        "Inês escolhe preservar as memórias dos outros e aceita ser esquecida.",
      currentFocus:
        "Testar a regra do nome que aparece com o calor da lamparina",
      lockedFields: ["promise", "boundaries"],
      updatedAt: now,
    });

    const canon = new SqliteCanonRepository(database);
    const hero = canon.insertEntity(
      createCanonEntity({
        id: "example-entity-ines",
        projectId,
        type: "character",
        name: "Inês Valadares",
        description:
          "Restauradora de papel de 27 anos; primeiro confere a prova, depois se permite acreditar.",
        attributes: {
          pov: true,
          habit:
            "Quando fica nervosa, confere a borda do papel com a ponta dos dedos",
        },
        now,
      }),
    );
    const sister = canon.insertEntity(
      createCanonEntity({
        id: "example-entity-lia",
        projectId,
        type: "character",
        name: "Lia Valadares",
        description:
          "Irmã mais velha de Inês, sumida há sete anos; deixou uma carta em branco na gaveta da oficina.",
        now,
      }),
    );
    const postOffice = canon.insertEntity(
      createCanonEntity({
        id: "example-entity-post-office",
        projectId,
        type: "location",
        name: "Correio das Marés",
        aliases: ["Correio da Maré Baixa"],
        description:
          "Só abre nos quarenta e sete minutos depois da maré baixa.",
        now,
      }),
    );
    canon.insertFact(
      createCanonFact({
        id: "example-fact-hours",
        projectId,
        subjectId: postOffice.id,
        predicate: "janela de atendimento",
        value: "47 minutos depois da maré baixa",
        authority: "locked",
        sourceType: "example-seed",
        now,
      }),
    );
    canon.insertFact(
      createCanonFact({
        id: "example-fact-sister",
        projectId,
        subjectId: sister.id,
        predicate: "sumiu há",
        value: "sete anos",
        sourceType: "example-seed",
        now,
      }),
    );

    const root = story.insertOutlineNode(
      createOutlineNode({
        id: "example-outline-book",
        projectId,
        parent: null,
        kind: "book",
        ordinal: 0,
        title: "O Correio das Marés",
        now,
      }),
    );
    const chapter = story.insertOutlineNode(
      createOutlineNode({
        id: "example-outline-chapter-1",
        projectId,
        parent: root,
        kind: "chapter",
        ordinal: 0,
        title: "Capítulo 1 — Marcas de maré sob a lamparina",
        summary:
          "Inês usa a lamparina a querosene para testar a carta em branco que a irmã deixou.",
        goal: "Estabelecer a regra verificável do nome que aparece com o calor",
        conflict: "Cada nome revelado apaga uma lembrança de Inês ligada a ele",
        povEntityId: hero.id,
        storyTime: "Dia 1, 23h17",
        now,
      }),
    );
    story.updateOutlineStatus(projectId, chapter.id, "committed", now);
    story.insertOutlineNode(
      createOutlineNode({
        id: "example-outline-chapter-2",
        projectId,
        parent: root,
        kind: "chapter",
        ordinal: 1,
        title: "Capítulo 2 — O balcão das 23h40",
        summary:
          "Na maré seguinte, Inês volta ao correio para perguntar quem recebe cartas sem destinatário.",
        goal: "Mostrar que o correio guarda um registro das cartas entregues",
        conflict:
          "O atendente só responde a quem aceita entregar uma lembrança em troca",
        povEntityId: hero.id,
        storyTime: "Dia 2, 23h40",
        now,
      }),
    );
    story.insertOutlineNode(
      createOutlineNode({
        id: "example-outline-chapter-3",
        projectId,
        parent: root,
        kind: "chapter",
        ordinal: 2,
        title: "Capítulo 3 — Sobrenome em sal",
        summary:
          "O registro aponta para uma Valadares que nenhum documento da família menciona.",
        povEntityId: hero.id,
        now,
      }),
    );

    const documents = new SqliteDocumentRepository(database);
    const document = documents.insert(
      createDocument({
        id: "example-document-chapter-1",
        projectId,
        kind: "chapter",
        title: "Capítulo 1 — Marcas de maré sob a lamparina",
        outlineNodeId: chapter.id,
        now,
      }),
    );
    documents.appendVersion(projectId, document.id, {
      id: randomUUID(),
      content: CHAPTER_ONE,
      source: "example-seed",
      expectedCurrentVersionId: null,
      now,
    });

    const state = new SqliteNarrativeStateRepository(database, canon, story);
    state.insertRelationship({
      id: randomUUID(),
      projectId,
      fromEntityId: hero.id,
      toEntityId: postOffice.id,
      relation: "investiga",
      intensity: 0.7,
      state: { confiança: "condicional" },
      outlineNodeId: chapter.id,
      storyTime: "Dia 1, 23h17",
      sourceId: "example-seed",
      supersedesEventId: null,
      createdAt: now,
    });
    state.insertTimelineEvent({
      id: "example-event-letter-reveals-name",
      projectId,
      title: "A carta em branco revela um nome sob a lamparina",
      description:
        "O sal se acumula ao longo de traços invisíveis, e Inês perde em seguida uma lembrança dos gestos da irmã.",
      outlineNodeId: chapter.id,
      storyTimeStart: "Dia 1, 23h17",
      storyTimeEnd: "Dia 1, 23h19",
      sequence: 1,
      participants: [hero.id],
      causes: [],
      visibility: "reader",
      sourceId: "example-seed",
      createdAt: now,
      updatedAt: now,
    });
    state.insertForeshadow({
      id: "example-foreshadow-surname",
      projectId,
      title: "O destinatário tem o sobrenome de Inês",
      description:
        "A carta só revela “Valadares”, sugerindo que o destinatário é alguém que a família apagou de propósito.",
      status: "planted",
      importance: 4,
      targetFromNodeId: chapter.id,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: [chapter.id],
      resolutionNodeId: null,
      sourceId: null,
      createdAt: now,
      updatedAt: now,
    });

    new SqliteCreativeRepository(database).insertPersona({
      id: "example-persona-narrator",
      projectId,
      kind: "narrator",
      entityId: null,
      name: "Voz da maré",
      description: "Narrador em terceira pessoa próxima de Inês",
      instructions:
        "Escreva só ações e provas perceptíveis; não explique o tema pelas personagens.",
      voice: { distance: "close-third", cadence: "restrained" },
      profile: createDefaultPersonaCardProfile(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 0,
    });

    const delivery = new SqliteDeliveryRepository(database);
    delivery.insertStyleProfile({
      id: "example-style-evidence",
      projectId,
      name: "Prova material úmida",
      description:
        "As regras sobrenaturais aparecem por detalhes palpáveis e verificáveis.",
      rules: [
        "Ação antes da explicação",
        "Uma imagem central por parágrafo",
        "Quando uma regra aparece, o preço aparece junto",
      ],
      examples: ["O sal foi se acumulando ao longo de um traço invisível."],
      negativeRules: [
        "Não empilhar adjetivos",
        "O narrador não anuncia as emoções das personagens",
      ],
      source: "example-seed",
      active: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    delivery.insertWritingSkill({
      id: "example-skill-rule-chain",
      projectId,
      name: "Cadeia de provas da regra",
      description: "Ação, resultado e preço em três tempos.",
      instructions:
        "Sempre que revelar uma regra sobrenatural, escreva a ação da personagem, o resultado observável e o preço irreversível.",
      scopes: ["chapter", "review"],
      priority: 85,
      enabled: true,
      source: "example-seed",
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
  });
  return { projectId, created: true };
}
