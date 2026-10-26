<p align="center">
  <img src="assets/narralume-logo-wide.svg" alt="NarraLume" width="960">
</p>

<h3 align="center">Do manuscrito ou da ideia ao texto entregável.</h3>

NarraLume é um estúdio de escrita local-first, com inteligência artificial, para contos, novelas e romances. Você importa um manuscrito e trabalha nele — ou parte de uma ideia e deixa a IA construir o texto, sempre com o autor no comando: prosa, revisão e mudanças de cânone entram como candidatos até você aceitar.

A interface e os prompts oficiais são em **português brasileiro** (inglês como segundo idioma). Criar livros, importar, organizar a história, escrever, exportar e fazer backup não exige modelo de IA.

## Princípios

| Princípio                                         | Como o NarraLume trata                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Conhecimento da história não vive em chats soltos | Intenção do autor, outline, entidades, fatos, relações, linha do tempo e foreshadowing ficam na Bíblia da História. |
| Sugestão de IA não é decisão                      | Prosa, revisões e mudanças de cânone são candidatos até o autor aceitar.                                            |
| Tarefa longa sobrevive a falha                    | Runs com passos, checkpoints e recuperação.                                                                         |
| Manuscrito é portátil                             | Exportação (Markdown, texto, DOCX, EPUB), snapshots e backup SQLite.                                                |

## Da ideia ao manuscrito

1. **Criar ou importar.** Livro em branco, criação guiada por IA, ou importação de Markdown, texto, DOCX, HTML, EPUB.
2. **Declarar a intenção.** Promessa de leitura, tom, público, rumo do final.
3. **Construir a Bíblia.** Volumes, capítulos, cenas, entidades, fatos, cronologia.
4. **Escrever no estúdio.** Markdown (editor rico), versões, comentários, edição de seleção, delegação de capítulo.
5. **Revisar.** Achados com evidência; aceitar, rejeitar ou marcar falso positivo.
6. **Entregar.** Checagens de qualidade, exportação, snapshot e backup da biblioteca.

## Como rodar

```bash
npm ci
npm run dev
```

- Web: `http://127.0.0.1:4318`
- API: `http://127.0.0.1:4317`

Requer Node.js 24+ e npm 11+. Copie `.env.example` para `.env.local` para configurar provedores de modelo. Nunca commite `.env.local`.

| Comando                 | Função                                                       |
| ----------------------- | ------------------------------------------------------------ |
| `npm run verify`        | Formatação, lint, tipos, testes, evidência, licenças e build |
| `npm run test:e2e`      | Playwright                                                   |
| `npm run release:build` | Arquivo de release da plataforma atual                       |

Self-host: veja [Docker Compose](docs/docker.md). Dados, privacidade e backup: [data-and-backup](docs/data-and-backup.md).

Não é um editor colaborativo em tempo real nem um serviço de contas na nuvem. Um chat genérico basta para uma pergunta avulsa; o NarraLume vale quando outline, versões, cânone e tarefas longas precisam permanecer ligados.

## Licença

Apache-2.0. Veja [LICENSE](LICENSE), [NOTICE](NOTICE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Projeto derivado do [NarraLume original](https://github.com/abligail/narralume) (Apache-2.0); veja o [NOTICE](NOTICE) para a atribuição.
