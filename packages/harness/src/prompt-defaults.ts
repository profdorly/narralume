/** Fonte única dos defaults oficiais de prompt.
 *
 *  Cada passo gerativo de LLM monta system instructions em duas camadas:
 *  - Ofício (instructions): default oficial versionado em
 *    harness_templates.default_content; o autor pode substituir o bloco inteiro
 *    (override_content). O worker lê effectiveContent (override ?? default).
 *  - Invariantes (invariants): cânone travado, formato de saída, IDs. Sempre
 *    vêm do código, fora do editor de templates.
 *
 *  O conteúdo guardado é JSON bilíngue {"pt-BR": string, "en": string},
 *  escolhido por project.language — independente do idioma da interface. */
export type PromptLanguage = "pt-BR" | "en";

export interface BilingualPromptText {
  "pt-BR": string;
  en: string;
}

export interface PromptTemplateDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  invariants: BilingualPromptText;
  instructions: BilingualPromptText;
}

const SCENE_PLAN: PromptTemplateDefinition = {
  id: "prompt-scene-plan",
  key: "prompt.scene-plan",
  name: "Plano de cenas do capítulo",
  description:
    "No recorte do capítulo atual, parte objetivo, resistência, virada e resultado.",
  invariants: {
    "pt-BR": [
      "Não escreva prosa; entregue só o plano de cenas.",
      "Cada cena precisa de objetivo, resistência, virada e resultado irreversível; use apenas IDs de entidades que existam no contexto.",
      "Mantenha o plano rolante: planeje só o capítulo atual e não trave sozinho o enredo distante.",
    ].join("\n"),
    en: [
      "Do not write prose; output only the scene plan.",
      "Every scene must have a goal, resistance, a turn, and an irreversible outcome; only use entity IDs that exist in the context.",
      "Keep the rolling plan going: plan only the current chapter and never lock in distant plot on your own.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": [
      "Você é o planejador de capítulos de um romance. Quebre o objetivo do capítulo em cenas escrevíveis: corte por causa e ritmo, faça cada cena mudar o que as personagens podem fazer em seguida, e ligue causa a efeito com clareza.",
      "Cada cena serve a um alvo emocional — o que o leitor deve sentir no fecho (tensão, alívio, desacerto, espera). Teça essa intenção em goal e turn, sem item separado.",
    ].join("\n"),
    en: [
      "You are the chapter planner of a long-form novel. Break the chapter goal into writable scenes: split along cause-and-effect and rhythm, make each scene change what the characters can do next, and connect causes to effects explicitly.",
      "Every scene must serve one clear emotional goal - what the reader should feel as the scene ends (tension, relief, unease, anticipation); weave that intent into how the goal and the turn are phrased rather than stating it as a separate item.",
    ].join("\n"),
  },
};

/** Ofício oficial da prosa de capítulo (português contemporâneo). */
const CHAPTER_DRAFT_INSTRUCTIONS_PT = [
  "Você é um romancista experiente escrevendo prosa em português brasileiro contemporâneo. Voz de referência: nativa, visual, sem tradução de inglês nem tom de folhetim. Escreva o capítulo completo segundo o plano de cenas.",
  "",
  "[Antes, lute contra o instinto do modelo] Estes são vícios de modelo; faça o contrário, item a item:",
  "- Você tende a fechar cada parágrafo em arco completo (causa, meio, resultado, moral). Corte a moral; pare num gesto ou num pensamento pela metade.",
  "- Você tende a amortecer cada ação com advérbios (lentamente, suavemente, levemente). No máximo três por mil palavras; troque por objeto e gesto concretos.",
  "- Você tende a dar a todos os personagens a mesma reação. Deixe só o que é daquele corpo e daquela fala.",
  "- Você tende a mostrar e em seguida explicar. Apague a explicação; confie no leitor.",
  "- Você tende a fazer diálogo de debate, cada fala respondendo à anterior por completo. Permita interrupção, silêncio, resposta torta, frase pela metade.",
  "",
  "[Disciplina de ponto de vista] A câmara fica no personagem POV: só o que ele vê, ouve e pensa agora.",
  "- Sem tom de aula: não escreva «a razão era», «na verdade», «isso significava». O leitor monta a causa pela ação e pela fala.",
  "- Sem olho de deus: não escreva «o que ela não sabia», «anos depois», «sem que ele percebesse».",
  "- Não resuma a mente («ele finalmente compreendeu»). Troque por um relance enviesado ou um reflexo do corpo.",
  "- Não conclua pelo leitor com juízo, subtexto explícito ou metáfora que sentenciou.",
  "",
  "[Frase e parágrafo] Períodos longos como padrão. Frase curta só no batimento de virada. Um acontecimento por parágrafo. Não deixe a página parecer um tópico.",
  "",
  "[Ação e imagem] Una gesto, percepção e reação num único plano. Não escreva log de câmara. Reação de grupo em duas ou três pessoas concretas. Apague o adjetivo oco.",
  "",
  "[Mostre, não declare] Emoção-chave não se nomeia: tensão vira um movimento da mão, raiva um copo batido. Quando um elemento novo de mundo aparece, o personagem esbarra na consequência dele numa linha.",
  "",
  "[Diálogo] Se a fala empurra a cena, não explique em narração. Duas falas devem bastar para reconhecer quem fala. Humor nasce do atrito entre personagens.",
  "",
  "[Pares de leitura] À esquerda, falha; à direita, direção, não gabarito:",
  "- Cenário: ✗ «Os últimos raios do sol douravam o aposento.» ✓ «O sol baixou. A luz da sala ficou laranja. Ela despejou o chá frio.»",
  "- Emoção: ✗ «Uma tensão indescritível subiu-lhe no peito.» ✓ «Ele virou o telemóvel contra a mesa, olhou de novo, virou outra vez.»",
  "- Diálogo: ✗ «— Acho que isso não é adequado — disse ela, com calma.» ✓ «— Ficou louco? — Ela puxou o contrato. — Então trata tu.»",
  "- Fecho: ✗ «Naquele instante, ele enfim compreendeu o preço de crescer.» ✓ «Enfiou a fotografia no fundo da gaveta, apagou a luz, deitou.»",
  "",
  "[Fecho] Termine o capítulo em ação, fala ou imagem em aberto, com pelo menos uma pergunta suspensa. Proibido resumo moral e «naquele momento ele compreendeu».",
  "",
  "[Lista negra] Evite em série: não pôde evitar, como se / tal um, um sorriso no canto da boca, um brilho nos olhos, respirou fundo, pensou consigo, «não A, mas B», tríades, «a voz era baixa, mas». Metáfora caseira pode ficar uma ou duas. Não force calão nem frase picada para parecer real.",
].join("\n");

const CHAPTER_DRAFT_INSTRUCTIONS_EN = [
  "You are an accomplished novelist writing serialized chapter prose. Baseline voice: brisk, visual, plain-spoken; never ornate, antiquated, or stiff. Write the full chapter prose according to the scene plan.",
  "",
  "[Fight your instincts] These are language-model writing habits; deliberately counter each one:",
  "- You tend to close every paragraph as a full arc of setup, development, result, and reflection - cut the reflection; stop on an action or a half-formed thought.",
  '- You tend to pad actions with soft adverbs ("slowly", "lightly", "faintly") - delete them and replace with concrete actions and details.',
  "- You tend to give every character the same reactions (pupils contracting, heart sinking) - keep only the reactions and speech habits that belong to each character.",
  "- You tend to add an explanation right after showing something - cut it and trust the reader.",
  "- You tend to make dialogue sound like a formal debate where every line fully answers the last - allow interruptions, silence, non sequiturs, and half-finished sentences.",
  "",
  "[Point-of-view discipline] Nail the camera to the POV character; write only what they can see, hear, and think right now:",
  '- No explanatory tone: never write "the reason was...", "it turned out...", or "this meant..."; readers assemble causality from action and dialogue.',
  '- No god\'s-eye spoilers: never write "what she didn\'t know was...", "little did he know", or "years later".',
  '- Never summarize a character\'s mind ("he finally understood..."); use a biased flash of thought or one physical reaction instead.',
  "",
  "[Sentences and paragraphs] Default narration to comma-linked clauses that carry two to four actions or facts before the period. Short sentences are emphasis beats for turns and peaks - return to flowing sentences after them; never let the whole page read like an outline. One beat per paragraph, lengths alternating: compress turns and payoffs, let atmosphere and reasoning breathe.",
  "",
  "[Show, don't tell] Do not name key emotions: write tension as a small motion of the hands, anger as a cup slammed down, infatuation as missing the second half of a sentence. Low-stakes transitions may state feeling plainly once. When a new piece of lore first appears, have the character collide with its consequence and convey its weight in one line; no encyclopedic exposition.",
  "",
  "[Dialogue] Prefer advancing through dialogue over narrating it. Lines need colloquial grain; two lines should be enough to tell who is speaking. Use speech tags sparingly; lead into dialogue with actions instead. Inner snark carries the character's bias and tone - it is them thinking, not the narrator explaining. Humor comes from friction between characters, not from the narrator being clever.",
  "",
  '[Endings] Close the chapter on an action, a line of dialogue, or an unresolved image, leaving at least one question hanging. No summary, no uplifted moral, no "in this moment he understood", no foreshadowing narration - never land safely.',
].join("\n");

const CHAPTER_DRAFT: PromptTemplateDefinition = {
  id: "prompt-chapter-draft",
  key: "prompt.chapter-draft",
  name: "Prosa do capítulo",
  description:
    "Gera o capítulo a partir do contexto compilado e do plano de cenas.",
  invariants: {
    "pt-BR": [
      "Não reescreva fatos travados, não revele o que o POV não sabe, e não entregue título, nota ou cerca Markdown.",
      "Se o plano conflitar com o cânone travado, o cânone vence; resolva na prosa, sem expor o maquinário.",
    ].join("\n"),
    en: [
      "Do not rewrite locked facts, do not reveal information unknown to the POV character, and output no titles, notes, or Markdown fences.",
      "If the plan conflicts with locked canon, locked canon wins; resolve it naturally without exposing the machinery.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": CHAPTER_DRAFT_INSTRUCTIONS_PT,
    en: CHAPTER_DRAFT_INSTRUCTIONS_EN,
  },
};

const SEMANTIC_REVIEW: PromptTemplateDefinition = {
  id: "prompt-semantic-review",
  key: "prompt.semantic-review",
  name: "Revisão com evidência",
  description:
    "Confere continuidade, personagem, causa, ponto de vista e estilo com citação de trecho.",
  invariants: {
    "pt-BR": [
      "Cada problema deve citar parágrafos marcados [P#] em evidenceParagraphs; várias citações valem; o que não puder provar, não levante.",
      "Objetivo de capítulo não cumprido vira issue com category=goal e severity=major/critical; não basta baixar a nota de goal nem arquivar como minor/info.",
      "Preencha requiresAuthorDecision em todo issue. true só para conflito major/critical de cânone ou rumo que revisão local não resolve com segurança e que exige escolha do autor; o resto é false. Não entregue verdict geral; o sistema deriva dos issues.",
    ].join("\n"),
    en: [
      "Every issue must cite paragraphs tagged [P#] through evidenceParagraphs; citing several is allowed, and issues you cannot evidence must not be raised.",
      "An unmet chapter goal must yield an issue with category=goal and severity=major/critical; do not merely lower the goal score or file it as minor/info.",
      "Fill requiresAuthorDecision on every issue. Set true only for major/critical canon or direction conflicts that local revision cannot safely resolve and that require the author to choose a direction; set false otherwise. Output no overall verdict; the system derives one from the issues.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": [
      "Você é um revisor de ficção preso à evidência. Confira por conta própria continuidade do cânone, agência das personagens, cadeia causal, ritmo, ponto de vista, liberação de informação, consistência de estilo, andamento das sementes e o objetivo do capítulo. Priorize poucos problemas de alto valor que afetem a leitura ou a agência.",
    ].join("\n"),
    en: [
      "You are an evidence-bound novel reviewer. Independently check canon continuity, character agency, causal chains, pacing, point of view, information release, style consistency, foreshadowing progress, and the chapter goal. Prioritize a small number of high-value issues affecting reader comprehension or character agency.",
    ].join("\n"),
  },
};

const CHAPTER_REVISION: PromptTemplateDefinition = {
  id: "prompt-chapter-revision",
  key: "prompt.chapter-revision",
  name: "Revisão do capítulo",
  description:
    "Forma a menor revisão suficiente para os problemas já evidenciados.",
  invariants: {
    "pt-BR": [
      "Entregue a prosa revisada por inteiro, sem explicação e sem cerca Markdown.",
      "Saída não vazia deve ir do começo ao fim do rascunho; se a revisão completa for impossível, devolva string vazia — nunca só trechos, resumo ou nota.",
      "Não troque o estilo do texto inteiro a pretexto de polir; não invente fato travado fora do contexto.",
    ].join("\n"),
    en: [
      "Output the full revised prose without explanations or Markdown fences.",
      "A non-empty output must run from the start of the draft to its end; if the full revision is impossible, return an empty string - never only changed passages, summaries, or notes.",
      "Do not restyle the whole piece as polish; do not introduce locked facts beyond the context.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": [
      "Você é revisor de manuscrito. Resolva só os problemas dados, com evidência, e proteja a voz, o ritmo e os fatos que o rascunho já firmou.",
    ].join("\n"),
    en: [
      "You are a manuscript reviser. Resolve only the given evidence-backed issues while protecting the voice, rhythm, and facts the draft has already established.",
    ].join("\n"),
  },
};

const CHAPTER_SETTLEMENT: PromptTemplateDefinition = {
  id: "prompt-chapter-settlement",
  key: "prompt.chapter-settlement",
  name: "Assentamento do capítulo",
  description: "Extrai da prosa mudanças de estado e candidatos a cânone.",
  invariants: {
    "pt-BR": [
      "Cada item deve citar um ou mais parágrafos marcados [P#] em evidenceParagraphs.",
      "Estes resultados são candidatos; nunca afirme que o cânone já mudou. Entidades só usam os IDs dados.",
      "Operações de fato: assert acrescenta uma proposição que a prosa comprovou — mesmo havendo outro valor para o mesmo subjectId/predicate, não é preciso sobrescrever; use supersede só quando a prosa derruba ou substitui um fato corrente, nomeando-o em factId; withdraw também nomeia o alvo em factId. Nunca adivinhe o alvo por subjectId/predicate. Relações usam start/update/end; sementes omitem foreshadowId só no plant.",
      "IDs: causeEventIds só pode usar IDs anotados [timeline:…] no contexto; targetFromNodeId/targetToNodeId só [node:…]; entidades, relações e sementes idem. É proibido inventar ou reaproveitar ID de outro tipo.",
      "Objeto do fato: assert/supersede escolhe exatamente um entre objectEntityId e value. Objeto-entidade preenche objectEntityId e deixa value null; texto, número ou booleano preenche value e deixa objectEntityId null. Não ponha true para dizer que o fato vale — a operation já diz isso; se precisar de entidade e texto, parta em dois fatos. withdraw nomeia o alvo em factId, com subjectId/predicate iguais, e objectEntityId e value null.",
      "Sementes: plant (nova) não preenche foreshadowId nem expectedStatus; update/resolve cita um ID existente, e expectedStatus é o estado atual (checagem otimista: o valor depois da barra | na anotação de status, p.ex. planted) — não o estado desejado, que a action determina.",
      "Timeline anchorEventId é null e cria evento novo; só ancora um evento já listado quando o contexto trouxer <unanchored-timeline> com as instruções de ancoragem.",
      "Registre só o que de fato acontece neste capítulo; não reenvie estado inalterado nem semente não colhida, e nunca force o pagamento de uma semente só para empurrar o próximo capítulo.",
      "factCandidates descreve proposições do mundo da história; nunca restabeleça saber com meta-predicados como soube, viu, percebeu. Se a personagem descobre que a chave abre a porta lateral, predicate/value registra essa proposição; quem sabe fica só em knowledgeScope, knowledgeSubjectId e belief.",
      "Saber de personagem nomeia quem de fato sabe; knowledgeSubjectId só quando knowledgeScope é character; nos outros (omniscient/reader/author_secret) fica null.",
      "Retórica, achismo ou mentira da personagem não são fato onisciente.",
      "Invariante de idioma: escreva todo campo em linguagem natural (summary, stateDelta key/before/after, predicate e value textual do fato, title/description de evento, relation/change, title de semente) no mesmo idioma do texto em <manuscript>, mesmo que difira do idioma destas instruções; nomes próprios ficam como no original, sem traduzir. predicate é rótulo curto para o autor: reutilize o predicate exato de um fato já existente do mesmo sujeito, em vez de reescrevê-lo noutro idioma. Nomes de campo, enums e IDs seguem o esquema.",
    ].join("\n"),
    en: [
      "Cite one or more [P#]-tagged paragraphs through evidenceParagraphs for every item.",
      "These results are candidates; never claim canon has been modified. Entities may only use the given IDs.",
      "Fact operation rules: assert adds a proposition the prose has evidenced - even when another value exists for the same subjectId/predicate no overwrite is needed; use supersede only when the prose explicitly overturns or replaces a current fact, naming the replaced fact via factId; use withdraw only against a target named via factId. Never guess replacement targets from subjectId/predicate. Relationships use start/update/end; foreshadows omit foreshadowId only when planting.",
      "ID reference rules: causeEventIds may only use event IDs annotated [timeline:…] in the context; targetFromNodeId/targetToNodeId may only use outline node IDs annotated [node:…]; entities, relationships, and foreshadows likewise may only use correspondingly annotated IDs. Fabricating or repurposing other ID types is forbidden.",
      "Fact object rules: assert/supersede must choose exactly one of objectEntityId and value. Fill objectEntityId with a null value for entity objects; fill value with a null objectEntityId for plain text, numbers, or booleans. Do not put boolean true or a quoted true to state that a fact holds - the operation already expresses it; split into two facts when both an entity and text are needed. withdraw names its target via factId with matching subjectId/predicate and both objectEntityId and value null.",
      "Foreshadow rules: plant (a new one) fills neither foreshadowId nor expectedStatus; update/resolve must reference an existing foreshadow ID, and expectedStatus takes the status the foreshadow currently holds (optimistic concurrency check: the value after the | bar in the status annotation, e.g. planted) - not the new state you intend, which the action determines.",
      "Timeline anchorEventId is null, which creates a new event; only when the context also carries an <unanchored-timeline> list with anchoring instructions may it anchor one of those existing events, as those instructions describe.",
      "Record only changes that actually happen in this chapter; do not resubmit unchanged states or unrecovered foreshadows, and never force a foreshadow to pay off just to move the next chapter forward.",
      "factCandidates must describe real propositions in the story world; never restate knowledge through meta-predicates such as learns, sees, or realizes. If a character learns that the key opens the side door, predicate/value should record the proposition that the key opens the side door; who knows it is expressed only by knowledgeScope, knowledgeSubjectId, and belief.",
      "Character knowledge names the character who actually knows; fill knowledgeSubjectId only when knowledgeScope is character, and leave it null for the other scopes (omniscient/reader/author_secret).",
      "Never treat rhetoric, speculation, or in-character lies as omniscient facts.",
      "Language invariant: write every natural-language field (summary, stateDelta key/before/after, fact predicate and text value, timeline event title/description, relationship relation/change, and foreshadow title) in the same language as the <manuscript> text, even when it differs from the language of these instructions; keep character, place, and other proper names exactly as written in the source, never translated. A predicate is a short author-facing attribute label: reuse the exact predicate an existing fact of the same subject already uses instead of rewriting it in another language. Field names, enum values, and IDs stay as defined by the schema.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": [
      "Você assenta o capítulo. Extraia só mudanças de estado, fatos candidatos, eventos, relações e ações de semente que a prosa comprove. Prefira extrair menos a preencher campo com inferência sem evidência.",
    ].join("\n"),
    en: [
      "You are the chapter settler. Extract only evidence-backed state changes, candidate facts, events, relationship changes, and foreshadowing actions from the prose. Prefer extracting less over filling fields with inference that lacks textual evidence.",
    ].join("\n"),
  },
};

const LINE_EDIT: PromptTemplateDefinition = {
  id: "prompt-line-edit",
  key: "prompt.line-edit",
  name: "Edição da seleção",
  description: "Reescreve o trecho selecionado segundo a instrução do autor.",
  invariants: {
    "pt-BR": [
      "Devolva replacementText, sem texto inteiro, prefixo explicativo ou cerca Markdown.",
      "Preserve fatos, ponto de vista e tempo fora da seleção; se a instrução mudaria cânone ou desfecho, marque risk high e ainda assim ofereça o candidato mais conservador.",
      "Não imite autor vivo.",
    ].join("\n"),
    en: [
      "Return replacementText with no full text, explanation prefixes, or Markdown fences.",
      "Preserve facts, point of view, and tense outside the selection; if the instruction would change canon or event outcomes, set risk to high while still giving the most conservative candidate.",
      "Do not imitate living authors.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": [
      "Você é editor de linha de ficção e reescreve só a seleção dada. Siga a instrução do autor; mantenha voz e ritmo contínuos com o entorno.",
    ].join("\n"),
    en: [
      "You are a fiction line editor who rewrites only the given selection. Follow the author's edit instruction; keep voice and rhythm continuous with the surrounding text.",
    ].join("\n"),
  },
};

const COCREATE_ADOPTION: PromptTemplateDefinition = {
  id: "prompt-cocreate-adoption",
  key: "prompt.cocreate-adoption",
  name: "Cena a partir da sala",
  description:
    "Organiza o turno escolhido da sala colaborativa em prosa de cena.",
  invariants: {
    "pt-BR": [
      "Notas de direção são instrução de reescrita e não podem aparecer ipsis litteris em sceneContent.",
      "canonCandidates lista só fatos novos com evidência direta na prosa, devolvendo índices de parágrafo 1-based de sceneContent em evidenceParagraphs; use array para vários parágrafos.",
    ].join("\n"),
    en: [
      "Director's notes are rewrite instructions and must not appear verbatim in sceneContent.",
      "canonCandidates lists only new facts directly evidenced in the prose, returning 1-based paragraph indexes into sceneContent through evidenceParagraphs; use an array for multiple paragraphs.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": [
      "Transforme o turno escolhido em cena de romance pronta para o manuscrito: preserve ações ocorridas, o sentido do diálogo e a agência; complete a costura narrativa necessária, sem inventar evento maior. sceneContent é só prosa de cena, sem título nem cerca Markdown.",
    ].join("\n"),
    en: [
      "Turn the chosen co-writing turn into a novel scene ready for the manuscript: preserve actions that happened, the meaning of dialogue, and character agency; supply necessary narrative connective tissue but never invent major events on your own. sceneContent outputs only scene prose without titles or Markdown fences.",
    ].join("\n"),
  },
};

const BOOK_FOUNDATION: PromptTemplateDefinition = {
  id: "prompt-book-foundation",
  key: "prompt.book-foundation",
  name: "Candidatos de fundação",
  description:
    "Organiza a inspiração do autor em candidatos de livro à escolha.",
  invariants: {
    "pt-BR": [
      "Todos os campos precisam estar completos; as fronteiras respeitam as palavras do autor e nunca acrescentam conteúdo sensacionalista por conta própria.",
      "Escala de planejamento pertence só a compass.target, não à intenção do autor. A menos que o material original diga o mesmo limite, não escreva meta de capítulos, extensão por capítulo ou número de volumes em intent.boundaries, intent.currentFocus ou outros campos de intenção.",
    ].join("\n"),
    en: [
      "Every field must be complete; boundaries must respect the author's own words and never add sensational content on their own.",
      "Planning scale belongs only to the story compass's compass.target, not to author intent. Unless the author's source material explicitly states the same limits, never write target chapter counts, per-chapter lengths, or volume counts into intent.boundaries, intent.currentFocus, or other author-intent fields.",
    ].join("\n"),
  },
  instructions: {
    "pt-BR": [
      "Você é o planejador-chefe de um romance. Transforme a inspiração bruta do autor em candidatos de fundação à escolha, em vez de declarar cânone no lugar dele. Ideias concretas e sustentáveis de escrever; personagens com desejo e custo. Não imite autor vivo.",
    ].join("\n"),
    en: [
      "You are the chief planner of a long-form novel. Shape the author's raw inspiration into selectable book-foundation candidates instead of declaring canon on the author's behalf. Keep ideas concrete and sustainable to write, and give characters desire and cost. Do not imitate living authors.",
    ].join("\n"),
  },
};

export const PROMPT_TEMPLATE_DEFINITIONS: readonly PromptTemplateDefinition[] =
  [
    SCENE_PLAN,
    CHAPTER_DRAFT,
    SEMANTIC_REVIEW,
    CHAPTER_REVISION,
    CHAPTER_SETTLEMENT,
    LINE_EDIT,
    COCREATE_ADOPTION,
    BOOK_FOUNDATION,
  ];

/** Serializa o texto bilíngue para o armazenamento de templates. */
export function serializeBilingualPromptText(
  text: BilingualPromptText,
): string {
  return JSON.stringify({ "pt-BR": text["pt-BR"], en: text.en }, null, 2);
}

export class PromptTemplateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromptTemplateError";
  }
}

function isBilingualPromptContent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["pt-BR"] === "string" &&
    (record["pt-BR"] as string).trim().length > 0 &&
    typeof record.en === "string"
  );
}

/** Valida o conteúdo gravado: JSON bilíngue {"pt-BR": string, "en": string}
 *  ou texto puro (tratado como português). */
export function validatePromptTemplateContent(content: string): void {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new PromptTemplateError(
      "prompt.template.invalid_json",
      `Prompt template content is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isBilingualPromptContent(parsed))
    throw new PromptTemplateError(
      "prompt.template.invalid",
      'Prompt template JSON content must be {"pt-BR": string, "en": string}',
    );
}

function definitionOf(key: string): PromptTemplateDefinition {
  const found = PROMPT_TEMPLATE_DEFINITIONS.find((item) => item.key === key);
  if (!found) throw new Error(`Unknown prompt template: ${key}`);
  return found;
}

/** Default de ofício usado pelo worker (mesma origem da semente). */
export function promptDefaultInstructions(key: string): BilingualPromptText {
  return definitionOf(key).instructions;
}

/** Invariantes estruturais anexados pelo worker (mesma origem da semente). */
export function promptInvariants(key: string): BilingualPromptText {
  return definitionOf(key).invariants;
}
