[English](data-and-backup.en.md)

# Dados, privacidade e backup

As propostas de progresso das linhas da história e a decisão sobre cada item ficam na biblioteca atual e entram no backup SQLite completo. O pacote da história e os instantâneos do conteúdo guardam a bússola da história com as mudanças já aceitas, mas não levam o histórico de propostas e decisões. Para guardar o processo inteiro, faça um backup SQLite completo.

O NarraLume não tem sincronização na nuvem. Onde a obra fica de fato depende de como você o usa: no kernel local do navegador, com um Server local ou com o Docker. Entrar com a mesma conta no navegador não faz esses dados se comunicarem.

Primeiro, diferencie os três tipos de arquivo e as formas de recuperação:

| Objeto                  | Alcance                                        | Indicado para                                                                            | Contém chaves de modelo? |
| ----------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| Pacote da história      | Uma obra                                       | Levar uma obra para outra instalação do NarraLume ou entregá-la a quem colabora com você | Não                      |
| Instantâneo do conteúdo | Uma obra, guardada dentro da biblioteca atual  | Marcar uma etapa que você pode restaurar depois como projeto novo                        | Não                      |
| Backup SQLite completo  | A biblioteca inteira e as configurações locais | Recuperação de desastre antes de atualizar, trocar de máquina ou apagar os dados do site | Pode conter              |

Um hábito prático: crie um instantâneo do conteúdo ao terminar capítulos importantes, faça backups completos com regularidade e, antes de qualquer atualização ou migração, faça mais um backup completo e teste a restauração numa pasta nova. Uma pasta sincronizada pode guardar os arquivos de backup, mas a sincronização em si não é um backup recuperável.

## Kernel local do navegador

O kernel local do navegador entra em uso quando a página não encontra um Server respondendo em `/api/health` ou quando você escolhe "Núcleo local no navegador" em Configurações, na seção "Driver de execução". Se a biblioteca aparecer vazia de repente, confira nessa seção qual driver está em vigor.

Nesse modo, as obras, a bússola da história, o histórico de execuções e as chaves de modelo salvas na interface ficam num banco SQLite no OPFS do navegador e do site atuais.

- Os dados ficam isolados por site: trocar de domínio ou de perfil do navegador, ou abrir uma janela anônima, pode esconder a biblioteca original.
- Apagar os dados do site apaga a biblioteca local. Antes de limpar qualquer cache, clique em "Baixar minha biblioteca (.sqlite)" em Configurações e confira se o arquivo baixado pode ser lido.
- Quando o kernel do navegador chama um modelo diretamente, o provedor precisa permitir CORS para o site atual; com o Server local, a chamada segue outro caminho.
- A biblioteca do navegador não é copiada sozinha para a pasta `data/` do pacote de release e não sincroniza só porque você entrou com a mesma conta.

## Server local e launchers de release

Por padrão, o banco fica em `data/narralume.sqlite` e os backups consistentes vão para `data/backups/`. Quando você inicia o Server por conta própria (por exemplo, com `npm run dev`), `NARRATIVE_DATA_DIR` e `NARRATIVE_BACKUP_DIR`, no ambiente ou no `.env.local`, mudam essas pastas; sem `NARRATIVE_BACKUP_DIR`, os backups vão para `backups/` dentro da pasta de dados. Os próprios launchers definem essas duas variáveis: a pasta de dados vem de `NARRALUME_DATA_DIR` e os backups ficam em `backups/` dentro dela. Só o launcher de macOS/Linux também aceita `NARRATIVE_DATA_DIR` e `NARRATIVE_BACKUP_DIR` definidos no shell.

Enquanto roda (também no Docker), o Server faz um backup automático a cada 6 horas (`NARRATIVE_BACKUP_INTERVAL_MINUTES`, padrão `360`) e mais um ao iniciar, se `NARRATIVE_BACKUP_ON_STARTUP=true`. A cada backup novo, a pasta mantém só os 10 mais recentes (`NARRATIVE_BACKUP_RETENTION`), contando os automáticos e os feitos à mão; copie para outro lugar os que precisar guardar por mais tempo. Deixe nessa pasta só o que o NarraLume criou: um `.sqlite` sem manifesto ou um `.partial` esquecido faz a listagem e a criação de backups darem erro.

Não copie o arquivo principal do SQLite com o serviço rodando. Use o botão "Fazer backup agora" (em Configurações, seção "Arquivos de backup do sistema"), `scripts/backup.ps1` no Windows, `scripts/backup.sh` no macOS/Linux ou a API de backup do Server (`POST /api/system/backups`); o botão "Baixar minha biblioteca (.sqlite)" só funciona no kernel do navegador. O backup do Server é gravado primeiro num arquivo temporário (`.partial`), passa pelas checagens de integridade e de chaves estrangeiras do SQLite e só então recebe o nome final, ao lado de um manifesto (`.manifest.json`) que registra o SHA-256; a prévia e a restauração conferem esse hash. Assim, um arquivo pela metade nunca é tomado por backup recuperável.

No pacote de release dos launchers:

- `data/` guarda as obras e os backups e precisa entrar no seu plano pessoal de backup.
- `.runtime/logs/` guarda os logs de inicialização e de erro, para investigar quando o launcher não sobe; não é backup de dados.
- Os instantâneos do conteúdo não contêm provedores nem chaves; o backup SQLite completo pode conter credenciais de provedor salvas localmente.

## Volumes do Docker

O Compose põe o banco no volume `narralume-data` e monta os backups à parte, na pasta do host `${NARRATIVE_BACKUP_HOST_DIR:-./data/backups}`. Para mudar essa pasta, defina `NARRATIVE_BACKUP_HOST_DIR` no shell ou num arquivo `.env` na raiz do repositório; no `.env.local` ela não tem efeito. O volume em si não é backup, e a pasta de backups não deve ficar no mesmo disco frágil que guarda a única cópia do banco.

Crie um backup consistente com o serviço rodando:

```powershell
powershell -File scripts/docker-backup.ps1
```

Pare o serviço e mantenha os dados:

```powershell
powershell -File scripts/docker-stop.ps1
```

Não use `docker compose down --volumes`, a menos que queira mesmo apagar todos os dados das obras e já tenha um backup externo verificado.

## Instantâneos do conteúdo e pacote da história: recuperar e migrar uma obra

Servem para entregar uma obra a quem colabora com você, fazer uma cópia de experimento na mesma biblioteca ou deixar uma etapa legível antes da entrega:

1. Abra "Entrega" no projeto, preencha "Rótulo do backup" e clique em "Criar instantâneo do conteúdo".
2. Na lista de instantâneos, confira o rótulo, a data e as contagens de conteúdo.
3. Para migrar, baixe "Pacote da história" em "Formatos de exportação" (um arquivo `.narrative.json`) e importe-o no ambiente de destino. Markdown, Texto simples, DOCX e EPUB servem só para leitura e entrega.
4. Para voltar atrás, clique em "Restaurar cópia do conteúdo" na linha do instantâneo, confirme na caixa de diálogo e abra o projeto novo em "Abrir a cópia restaurada".
5. No projeto novo, confira a bússola da história, a estrutura, as versões mais recentes do manuscrito e os comentários. O projeto original não é sobrescrito, e o histórico de execuções não vem para a cópia.

O pacote baixado em "Formatos de exportação" leva só a versão atual de cada documento, sem histórico de versões, comentários nem execuções. O instantâneo do conteúdo guarda o histórico de versões e os comentários.

Os instantâneos não levam, de propósito, provedores nem chaves. Depois de restaurar, se quiser usar IA, configure e atribua os modelos de novo em Configurações no ambiente de destino.

O formato atual do pacote é a versão 6. Ele inclui os registros de conhecimento, os motivos de correção e de retirada, os fatos históricos referenciados e os eventos anulados. Restaurar ou duplicar preserva o conhecimento por capítulo e as cadeias de correção, sem reativar afirmações retiradas. Pacotes em formatos antigos não são mais aceitos: abra a biblioteca SQLite existente com a versão atual, que atualiza o banco ao iniciar, e exporte um pacote novo.

## Backup SQLite completo: recuperação da biblioteca inteira

Indicado antes de apagar os dados do site no navegador, antes de atualizar um pacote de release, antes de trocar de máquina e na homologação de uma versão candidata:

1. Pare o que estiver alterando o banco e crie um backup da biblioteca inteira. Com o Server local rodando, use "Fazer backup agora" em "Arquivos de backup do sistema", `scripts/backup.ps1` no Windows ou `scripts/backup.sh` no macOS/Linux; no kernel do navegador, use "Baixar minha biblioteca (.sqlite)" em Configurações.
2. Anote o SHA-256 do arquivo e copie-o para um armazenamento criptografado ou uma pasta sincronizada sob seu controle, fora da pasta do aplicativo. No Server, copie o `.sqlite` junto com o `.manifest.json` do mesmo backup: o manifesto registra o SHA-256, e a restauração pela interface depende dele.
3. Nos backups do Server, clique em "Prévia" em "Arquivos de backup do sistema" e confira se "Checagem de hash" mostra "Coincide", "Integridade" mostra `ok` e "Violações de chave estrangeira" está em 0.
4. Para recuperar, prepare uma pasta de destino nova; nunca sobrescreva o banco da instância em execução. Na prévia, clique em "Restaurar em um diretório novo", informe o "Diretório de destino no servidor" e confirme em "Restaurar no diretório de destino". O Server confere o hash e a integridade da cópia e recusa a pasta de dados atual, a pasta de backups e uma pasta que já tenha um banco.
5. Inicie uma instância de teste apontando para a pasta restaurada e confira a quantidade de obras, as versões mais recentes do manuscrito, a bússola da história, a estrutura, os comentários, o histórico de execuções e os instantâneos do conteúdo.
6. Só depois que o teste passar, pare a instância principal e aponte `NARRATIVE_DATA_DIR` (ou `NARRALUME_DATA_DIR`, nos launchers) para a pasta restaurada; mantenha a pasta antiga até a nova instância rodar de forma estável.

## Como confirmar que um backup funciona de verdade

Não se contente com "o arquivo existe". Restaure de tempos em tempos um backup completo numa pasta de teste nova e confira a quantidade de obras, as versões mais recentes do manuscrito, a estrutura, os fatos confirmados, os comentários e o histórico de execuções. Anote o nome do arquivo, a data de criação, o SHA-256, a versão do aplicativo e a pasta da restauração. Só apague os dados de teste depois que a instância de teste estiver em ordem; a pasta de dados principal fica intocada.

Quem mantém o projeto também deve verificar se a restauração deixou para trás arquivos `.partial`, `.partial-shm` ou `.partial-wal` e guardar um registro de restauração revisável para cada versão candidata.

Quem mantém o projeto pode começar por `npm run test:release:recovery`, com os testes de regressão de restauração de backup, de interrupção de execuções órfãs e de recuperação parcial. Para uma versão candidata, rode `npm run verify:release`, que executa, nesta ordem, a verificação do código, a suíte E2E completa, os testes de recuperação e a matriz com modelos reais. Essas checagens automáticas só verificam os contratos já codificados; não substituem o ensaio de restauração numa pasta separada nem a conferência manual descritas acima.

Se um backup tiver credenciais reais de modelo, não publique em Issues públicas, artefatos de CI ou capturas de tela as chaves, o banco completo ou respostas de modelo, nem mesmo ao lado do hash do backup. Para incidentes de segurança, veja [SECURITY.md](../SECURITY.md).
