import {
  AssistantToolDescriptorSchema,
  assistantToolAccess,
  type AssistantToolDescriptorDto,
  type AssistantToolName,
} from "@lapis/contracts";

interface AssistantToolDescriptorSeed {
  readonly name: AssistantToolName;
  readonly label: string;
  readonly description: string;
}

/**
 * The project assistant can only propose tools declared here. This is a
 * code-owned allowlist, not a model-authored capability list. The access
 * grading (read / auto / confirm) lives in
 * `@lapis/contracts` assistant-tool-policy and is shared with the
 * narrative stage worker; these descriptors only carry author-facing copy.
 */
const ASSISTANT_TOOL_COPY: readonly AssistantToolDescriptorSeed[] = [
  {
    name: "story.inspect",
    label: "Ver estado da história",
    description:
      "Consulta somente leitura da intenção da autoria, estrutura, personagens, cânone, linha do tempo e antecipações.",
  },
  {
    name: "review.inspect",
    label: "Ver estado da revisão",
    description:
      "Consulta somente leitura dos relatórios de revisão recentes, problemas em aberto e decisões.",
  },
  {
    name: "foundation.start",
    label: "Organizar a direção da história",
    description:
      "Reutiliza a tarefa de fundação existente; cada candidato ainda precisa da sua aceitação.",
  },
  {
    name: "chapter.start",
    label: "Começar a escrita de um capítulo",
    description: "Inicia a produção de um capítulo já definido na estrutura.",
  },
  {
    name: "autopilot.start",
    label: "Começar criação rápida com IA",
    description:
      "Inicia uma sessão de criação contínua ou capítulo a capítulo.",
  },
  {
    name: "outline.plan.start",
    label: "Planejar os próximos capítulos",
    description:
      "Gera ou completa nós da estrutura para os capítulos seguintes; a tarefa termina quando o plano está pronto, sem escrever prosa.",
  },
  {
    name: "canon.candidate.start",
    label: "Gerar alterações candidatas do cânone",
    description:
      "Gera alterações estruturadas para um bloco da história; a aceitação continua sendo item a item.",
  },
  {
    name: "selection.edit.start",
    label: "Editar o texto selecionado",
    description:
      "Gera um candidato de edição para a seleção atual; a aceitação continua sendo sua.",
  },
  {
    name: "long_goal.start",
    label: "Iniciar tarefa composta de criação",
    description:
      "Quando o objetivo final é prosa, encadeia direção da história, estrutura dos capítulos e criação contínua pelo número pedido.",
  },
  {
    name: "task.control",
    label: "Controlar a tarefa atual",
    description:
      "Controla um run ou sessão de criação rápida já existente e trata falhas de capítulo recuperáveis.",
  },
];

export const ASSISTANT_TOOL_REGISTRY: readonly AssistantToolDescriptorDto[] =
  ASSISTANT_TOOL_COPY.map((tool) =>
    AssistantToolDescriptorSchema.parse({
      ...tool,
      access: assistantToolAccess(tool.name),
    }),
  );
