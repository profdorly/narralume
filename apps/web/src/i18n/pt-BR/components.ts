export const components = {
  confirmDialog: {
    pending: "Trabalhando…",
  },
  empty: {
    seal: "V",
    sealLabel: "Selo da página “{char}”",
  },
  errorNote: {
    defaultTitle: "Algo deu errado",
  },
  projectRequired: {
    backToShelf: "Voltar à estante",
  },
  seal: {
    label: "Selo “{char}”",
  },
  kernel: {
    lockBusy:
      "O núcleo local está em uso em outra aba. Feche as outras páginas do Narralume e tente de novo.",
    deserializeFailed: "Não foi possível ler uma mensagem do núcleo",
    workerTerminated: "O worker do núcleo foi encerrado",
    bootTimeout:
      "O núcleo demorou demais para iniciar (o worker pode ter falhado ao carregar ou estar preso em outra aba)",
    workerBootFailed: "O worker do núcleo não iniciou",
    pageClosed: "A página foi fechada e o núcleo parou",
    requestFailed: "A solicitação ao núcleo falhou",
  },
};
