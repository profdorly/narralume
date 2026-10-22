# ADR 001 — Local-first agora, fronteiras para SaaS depois

## Status

Aceito (2026-10-20).

## Contexto

NarraLume nasceu como estúdio local-first: SQLite no Node (`data/narralume.sqlite`) e o mesmo esquema via sqlite-wasm em OPFS no navegador. Não há usuário, tenant nem autenticação além de um token Bearer opcional. O objetivo de produto é uma suíte de escrita em português (conto até romance), com importação de manuscrito ou geração a partir de uma ideia. SaaS multiusuário é um horizonte, não o MVP.

## Decisão

1. **Persistência:** manter SQLite (Node + OPFS) como armazenamento canônico. Novos recursos não introduzem FTS5, `WITHOUT ROWID` ou SQL específico fora de `packages/persistence`. Serviços e rotas falam só com repositórios.
2. **Identidade:** o isolamento continua sendo `project_id`. Services não assumem um único operador implícito; qualquer filtro de projeto passa por uma interface de repositório. Uma futura `AuthContext` / `tenantId` entra nessa borda, não no domínio narrativo.
3. **API:** o contrato HTTP em `packages/services` permanece a única superfície pública, compartilhada pelo Server Fastify e pelo kernel do navegador. Não acoplar UI ao driver.
4. **Demo público:** Bridge, Relay, Wrangler e Turnstile foram removidos. Não reintroduzir caminho de demo com chave no servidor de terceiros.
5. **Postgres:** um driver futuro substitui `packages/persistence` por trás das mesmas interfaces. JSONB cobre colunas `*_json`; FTS vira `tsvector` / `pg_trgm`. Não portar as 48 migrações SQLite literalmente — gerar schema inicial + migrações Postgres a partir do estado atual.

## Consequências

- O MVP continua instalável com `npm run dev`, Docker Compose ou o launcher local.
- Evoluir para contas e sync exige um projeto de tenancy, não um atalho no OPFS.
- Testes de persistência e backups SQLite continuam sendo a rede de segurança da camada de dados.
