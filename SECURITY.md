# Política de segurança

## Escopo

Antes da primeira versão estável, correções valem para a branch padrão e o GitHub Release mais recente.

## Relato privado

Use **Report a vulnerability** na página Security do repositório. Não abra Issue público para vazamento de chave, bypass de autenticação, acesso remoto ou destruição de dados.

Inclua versão afetada, passos de reprodução, impacto e mitigação possível. Os mantenedores confirmam o recebimento em até 7 dias.

Se uma credencial entrou em Git, log ou artefato público, rodeie-a no serviço correspondente; apagar o arquivo não invalida a chave antiga.

## Fronteiras

O Server local escuta só em loopback por padrão. Escuta remota exige modo produção, permissão explícita, token de alta entropia e TLS na borda. OPFS, SQLite, backups completos e `.env.local` podem conter manuscritos e chaves — trate-os como segredo.
