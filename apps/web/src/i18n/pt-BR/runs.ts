export const runs = {
  title: "Central de execuções",
  pageIndex: "EXECUÇÕES · L1",
  issueNo: "EDIÇÃO Nº {no}",
  runHeading: "EXECUÇÃO {id}",
  volumeMeta: "{runs, plural, one {# execução} other {# execuções}} / {issues, plural, one {# edição} other {# edições}}",
  issueArchiveLabel: "Arquivo de edições",
  catalog: {
    title: "Catálogo de volumes",
    count: "{count, plural, one {# edição} other {# edições}}",
  },
  emptyGuide: "Ainda não há execuções; gere um capítulo a partir da estrutura na Bíblia da história.",
  issueTitle: "Edição {issue} · {count, plural, one {# execução} other {# execuções}}",
  currentIssueLabel: "Edição atual",
  emptyArchive: "Ainda não há arquivo",
  volumePrefix: "Este volume · {issue}",
  sheetCount: "{count, plural, one {# entrada} other {# entradas}}",
  sheetMeta:
    "Concluídas {completed} · Falhas {failed} · Aguardando nova tentativa {retry} · Em andamento {running}",
  revisionCycles: "{count, plural, one {# ciclo de reescrita} other {# ciclos de reescrita}}",
  retryIncluded: "Inclui tentativas automáticas",
  modelCallsCount: "{count, plural, one {# chamada de modelo} other {# chamadas de modelo}}",
  modelCallsWithId: "{count, plural, one {# chamada de modelo} other {# chamadas de modelo}} · {id}",
  selectHint:
    "Selecione uma execução para ver o texto persistido, a política, os recibos, os instantâneos do modelo e o livro de chamadas.",
  actionSubmitted: "Ação enviada; os detalhes estão sendo atualizados a partir do servidor.",
  detailLabel: "Detalhes da execução {id}",
  handleCanonChange: "Resolver mudanças da história",
  backToAutopilot: "Voltar à tarefa de criação rápida",
  flowProgress: "Passos {done}/{total}",
  inputTokens: "Entrada {count, plural, one {# token} other {# tokens}}",
  outputTokens: "Saída {count, plural, one {# token} other {# tokens}}",
  wallTime: "Tempo do modelo {seconds}s",
  attempt: "Tentativa {attempt}/{max}",
  blocks: {
    streams: "Fluxos de texto",
    noStreams: "Ainda não há fluxos de texto.",
    liveIncrement: "Incremento ao vivo · ainda não persistido",
    steps: "Passos e erros",
    events: "Eventos, checkpoints e revisões",
    policy: "Política de execução vigente",
    receipts: "Recibos de contexto {count}",
    snapshots: "Instantâneos do modelo {count}",
    calls: "Livro de chamadas {count}",
    noCalls: "Ainda não há chamadas.",
    callMetrics: "TTFT {ttft}ms · total {duration}ms · tokens {tokens}",
  },
  confirmCancel: {
    title: "Cancelar execução",
    confirm: "Confirmar cancelamento",
    body: "O cancelamento encerra os passos inacabados; o texto parcial persistido permanece nos detalhes para recuperação.",
  },
  revision: {
    ariaLabel: "Instrução de reescrita",
    placeholder:
      "Instrução para o modelo de reescrita; deixe em branco para usar a diretriz padrão.",
    defaultInstruction:
      "Reescreva e melhore esta versão do texto, preservando os pontos fortes que já existem.",
  },
  stream: {
    attemptOnly: "Tentativa {attempt}",
    continue: "Continuar",
    discard: "Descartar",
    tooShortTitle:
      "Menos de {count} caracteres; não é possível continuar nem adotar",
    tooShortWarning:
      "O trecho parcial tem menos de {count} caracteres; só dá para descartar ou gerar de novo.",
  },
  missing: {
    description:
      "Selecione um projeto para revisar o processo, os resultados, o uso de modelo e os motivos de falha de cada execução de IA.",
  },
  error: {
    loadList: "Não foi possível carregar os registros de tarefa agora",
    loadDetail: "Não foi possível carregar os detalhes da tarefa agora",
    action: "A operação da execução não foi concluída",
  },
};
