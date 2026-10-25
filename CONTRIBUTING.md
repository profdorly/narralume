# Como contribuir

Obrigado por melhorar o NarraLume. Ao enviar uma contribuição você concorda com a licença Apache-2.0 e com o [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Vulnerabilidades não vão para Issue público: use [SECURITY.md](SECURITY.md).

## Ambiente

Node.js 24+, npm 11+. Workspaces npm com lockfile. Na primeira instalação e no CI:

```bash
npm ci
npm run dev
```

Web em `http://127.0.0.1:4318`, API em `http://127.0.0.1:4317`. Variáveis locais: copie `.env.example` para `.env.local` (nunca commitar). Para ter um livro para explorar, `npm run seed:example` grava o exemplo "O Correio das Marés" na biblioteca de `NARRATIVE_DATA_DIR` (padrão `./data`); rodar de novo não duplica.

Antes de mudar código:

1. Confirme se a capacidade já existe no repositório.
2. Respeite as camadas: `apps/web` (UI e kernel OPFS), `apps/server` (API local), `packages/` (domínio, serviços, persistência).
3. Saída de IA permanece candidata até o autor decidir.
4. SQL específico de SQLite (FTS5 etc.) não sai de `packages/persistence`. Ver [ADR 001](docs/adr/001-local-first-e-fronteiras-saas.md).

## Testes

```bash
npm run verify
```

| Mudança                | Verificação extra              |
| ---------------------- | ------------------------------ |
| UI, rotas, layout      | `npm run test:e2e`             |
| Serviços, persistência | `npm run test:coverage`        |
| Docker                 | `docker compose up -d --build` |
| Dependências           | `npm run licenses:update`      |

Migração de schema precisa de teste de upgrade a partir de banco antigo. Não use o banco corrente como alvo de restore destrutivo.

Idioma da interface e dos prompts oficiais: **pt-BR** (inglês secundário). Não reintroduzir zh-CN.

## Pull request

Um PR, um problema. Inclua comportamento visível, escolhas de implementação, comandos rodados e impacto em dados/credenciais. Não envie `.env.local`, bancos, backups nem respostas reais de modelo.
