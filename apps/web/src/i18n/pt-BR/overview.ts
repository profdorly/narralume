export const overview = {
  requiredState: {
    title: "Visão geral do projeto",
    description:
      "Selecione uma obra para ver o progresso da escrita, as tarefas em andamento e o próximo passo.",
  },
  loadError: "A visão geral está temporariamente indisponível",
  masthead: {
    emptyPremise: "A página de abertura ainda não foi escrita.",
    progress: "{committed, plural, one {# registrado} other {# registrados}} · {total, plural, one {# capítulo} other {# capítulos}} · {words, plural, one {# caractere} other {# caracteres}}",
    lastWriting: "Última escrita {time}",
    neverWriting: "Ainda não houve escrita",
  },
  currentChapter: {
    head: "Capítulo atual",
    continue: "Continuar a escrever",
    continueAria: "Continuar este capítulo na mesa de escrita",
    viewStory: "Ver a história",
  },
  style: {
    head: "Voz do livro",
    manage: "Gerenciar a voz",
    setUp: "Definir o estilo",
    empty:
      "Este livro ainda não tem um perfil de estilo: cole um trecho da sua escrita para destilar a voz desta obra.",
    layerNote:
      "Os modelos de prompt regem o ofício em geral; a voz do livro rege só o tom desta obra.",
  },
  completed: {
    noChapters: "Ainda não há capítulos; próximo passo: montar a estrutura da história.",
    reviewFoundation:
      "Nenhum capítulo está sendo escrito; próximo passo: confirmar a direção da história.",
    resolveStoryChanges:
      "Há capítulos registrados; próximo passo: confirmar as mudanças que o manuscrito trouxe à história.",
    reviewWriting:
      "Há capítulos registrados; próximo passo: tratar revisão e reescritas.",
    buildOutline: "Ainda não há capítulos prontos para escrever; próximo passo: montar a estrutura.",
    complete: "Todos os capítulos estão registrados; próximo passo: conferir e entregar.",
    fallback: "Nenhum capítulo está sendo escrito; próximo passo: {action}.",
  },
  entries: {
    next: "A SEGUIR · {action}",
    ariaLabel: "Entradas do próximo passo",
    organizeStory: {
      label: "Organizar a história",
      blurb: "Preencher personagens, estrutura e fatos da história",
    },
    autopilot: {
      label: "Criação rápida com IA",
      blurb: "Concluir vários capítulos no fluxo padrão; você pode intervir a qualquer momento",
    },
  },
  nextAction: {
    continueTask: {
      label: "Continuar a tarefa atual",
      blurb: "Voltar ao ponto de partida para tratar rascunhos candidatos ou seguir escrevendo",
    },
    backToStudio: {
      label: "Voltar à mesa de escrita",
      blurb: "Continuar o manuscrito atual",
    },
    reviewFoundation: {
      label: "Confirmar a direção da história",
      blurb: "Escolher a bússola da história entre os candidatos de fundação",
    },
    resolveStoryChanges: {
      label: "Confirmar mudanças da história",
      blurb: "Decidir mudanças de personagem, linha do tempo e antecipações trazidas pelo manuscrito",
    },
    reviewWriting: {
      label: "Tratar revisão e reescritas",
      blurb: "Decidir problemas e sugestões ao lado do manuscrito",
    },
    writeChapter: {
      label: "Continuar este capítulo",
      blurb: "Escreva à mão, ou passe o capítulo à IA para um manuscrito adotável",
    },
    buildOutline: {
      label: "Montar primeiro a estrutura da história",
      blurb: "Decidir personagens, capítulos e a direção da história",
    },
    complete: {
      label: "Conferir e entregar",
      blurb: "Exportar ou fazer backup da obra depois das checagens de qualidade",
    },
  },
  activeTask: {
    aria: "Tarefa ativa",
    head: "Tarefa ativa · {kind}",
    fallbackTitle: "Tarefa em segundo plano",
    backAria: "Voltar à tarefa",
    backLabel: "Voltar à tarefa",
    decideLabel: "Tratar candidatos e decisões",
    error: "A ação da tarefa não foi concluída",
  },
  cancelDialog: {
    title: "Cancelar a tarefa atual",
    confirm: "Confirmar cancelamento",
    body: "A tarefa para num limite seguro; o manuscrito e as versões já salvos não são excluídos.",
  },
  pending: {
    aria: "Pendências",
    foundation: "Candidatos de fundação",
    issues: "Pontos de revisão",
    proposals: "Propostas de reescrita",
    canon: "Mudanças da história",
    resume: "Última tarefa de IA · {label}",
  },
};
