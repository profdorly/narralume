import { AgentSkillSchema, type AgentSkillDto } from "@lapis/contracts";

/**
 * Built-in Agent Skill registry: code-owned, separate from Writing Skill
 * (the prose prompt layer). Skills declare trigger scope, required context,
 * allowed domain capabilities, output kind and checkpoint; execution always
 * reuses the assistant tool registry and existing Run/Session objects.
 */
export const AGENT_SKILL_REGISTRY: readonly AgentSkillDto[] = [
  {
    id: "story.query",
    label: "Consulta da história",
    description:
      "Consulta somente leitura de fatos, estrutura, cânone, linha do tempo, antecipações e estado das execuções.",
    triggerDescription:
      "Pergunta sobre o estado atual da obra, consistência, progresso ou o próximo passo.",
    requiredContext: ["project"],
    allowedCapabilities: ["story.inspect", "review.inspect"],
    outputKind: "answer",
    checkpoint: "none",
    builtin: true,
  },
  {
    id: "book.foundation",
    label: "Fundação e planejamento",
    description:
      "Organiza candidatos de direção e completa a estrutura dos capítulos seguintes.",
    triggerDescription:
      "Organiza a direção do zero, ou completa nós da estrutura para os capítulos seguintes.",
    requiredContext: ["project"],
    allowedCapabilities: ["foundation.start", "outline.plan.start"],
    outputKind: "candidate",
    checkpoint: "confirm_start",
    builtin: true,
  },
  {
    id: "chapter.write",
    label: "Escrita de um capítulo",
    description:
      "Gera prosa candidata para um capítulo definido e para na fronteira de confirmação.",
    triggerDescription:
      "Indica um capítulo existente e pede à IA a prosa candidata.",
    requiredContext: ["project", "outlineNode"],
    allowedCapabilities: ["chapter.start"],
    outputKind: "candidate",
    checkpoint: "confirm_start",
    builtin: true,
  },
  {
    id: "serial.write",
    label: "Criação contínua",
    description:
      "Avança em série uma sessão de criação rápida de vários capítulos.",
    triggerDescription:
      "Indica um número de capítulos e conclui um trecho de prosa em criação rápida.",
    requiredContext: ["project"],
    allowedCapabilities: ["autopilot.start"],
    outputKind: "task_handle",
    checkpoint: "confirm_start",
    builtin: true,
  },
  {
    id: "compose.serial",
    label: "Tarefa composta de criação",
    description:
      "Organiza a direção, completa a estrutura e cria continuamente o número de capítulos pedido.",
    triggerDescription:
      "Encaminha uma tarefa longa: organizar a estrutura → criar capítulos → criação contínua.",
    requiredContext: ["project"],
    allowedCapabilities: [
      "foundation.start",
      "outline.plan.start",
      "autopilot.start",
    ],
    outputKind: "long_goal",
    checkpoint: "confirm_start",
    builtin: true,
  },
  {
    id: "review.run",
    label: "Revisão",
    description:
      "Consulta o estado da revisão e os problemas em aberto; a revisão profunda é outra tarefa, sob demanda.",
    triggerDescription:
      "Pergunta sobre as conclusões atuais, problemas em aberto ou o histórico de decisões.",
    requiredContext: ["project"],
    allowedCapabilities: ["review.inspect"],
    outputKind: "answer",
    checkpoint: "none",
    builtin: true,
  },
  {
    id: "canon.edit",
    label: "Edição do cânone",
    description:
      "Gera alterações estruturadas para um bloco da história; a aceitação continua item a item.",
    triggerDescription:
      "Pede mudanças explícitas em personagens, cânone, linha do tempo, antecipações e outros blocos.",
    requiredContext: ["project", "canonSpread"],
    allowedCapabilities: ["canon.candidate.start"],
    outputKind: "candidate",
    checkpoint: "candidate_adoption",
    builtin: true,
  },
  {
    id: "selection.polish",
    label: "Polimento local",
    description: "Gera um candidato de edição para a seleção atual.",
    triggerDescription:
      "Com um trecho selecionado, pede polimento, reescrita ou aperto.",
    requiredContext: ["project", "document", "selection"],
    allowedCapabilities: ["selection.edit.start"],
    outputKind: "candidate",
    checkpoint: "candidate_adoption",
    builtin: true,
  },
].map((skill) => AgentSkillSchema.parse(skill));
