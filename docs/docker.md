[English](docker.en.md)

# Auto-hospedagem com Docker Compose

O Docker é a opção avançada de auto-hospedagem a partir do repositório de código-fonte; antes, instale e inicie o Docker Desktop ou o Docker Engine. Os pacotes de release para desktop não incluem o contexto de build do Docker.

Antes de começar, confirme:

- o Docker Engine/Desktop está rodando, com Docker Compose 2.24 ou mais recente (o `docker-compose.yml` usa `env_file` com `required: false`);
- a porta 4318 não está em uso por outro serviço;
- na raiz do repositório dá para criar um `.env.local`, só para esta máquina, e a pasta `data/backups/`;
- se for acessar de outros dispositivos, TLS, proxy reverso, controle de acesso e um local de backup independente já estão prontos.

No Windows, rode:

```powershell
powershell -File scripts/docker-start.ps1
```

O script verifica o Docker, grava um `NARRATIVE_AUTH_TOKEN` aleatório num arquivo `.env` na raiz do repositório se ainda não houver um, sobe o Compose, espera a verificação de saúde e abre o navegador. Você também pode fazer isso à mão:

```bash
docker compose up -d --build
```

Acesse `http://127.0.0.1:4318`. O Server não publica porta no host; o Nginx encaminha `/api` na mesma origem e acrescenta o token de autenticação. As obras ficam no volume `lapis-data`, e os backups vão para `${NARRATIVE_BACKUP_HOST_DIR:-./data/backups}`.

O Compose só preenche `${NARRATIVE_AUTH_TOKEN}`, `${NARRATIVE_WEB_BIND_HOST}` e `${NARRATIVE_BACKUP_HOST_DIR}` com valores do shell ou de um arquivo `.env` na raiz do repositório (o Git e o build do Docker ignoram esse arquivo). O `.env.local` é repassado ao contêiner do Server, então serve para chaves de modelo e outras variáveis do Server, mas não muda essas três nem os valores que o `docker-compose.yml` fixa em `environment`: sem `.env` nem variável no shell, os dois contêineres usam o token padrão `local-compose-token-change-me-24`. Versões anteriores do `docker-start.ps1` gravavam o token no `.env.local`, onde ele não tem efeito; rode o script de novo para criar o `.env`. No Linux/macOS, crie o token assim antes do primeiro `docker compose up`:

```bash
printf 'NARRATIVE_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
```

Confira o estado:

```bash
docker compose ps
docker compose logs --tail 100 server web
```

A verificação de saúde fica em `http://127.0.0.1:4318/api/health`. Nunca cole em uma Issue pública tokens, requisições a modelos ou trechos do manuscrito que apareçam nos logs.

Comandos de manutenção no Windows:

```powershell
# Cria um backup consistente online; os arquivos vão para a pasta de backups montada à parte
powershell -File scripts/docker-backup.ps1
# Atualiza um checkout sem alterações locais, reconstrói as imagens e espera a verificação de saúde
powershell -File scripts/docker-update.ps1
# Para os contêineres e mantém os volumes de dados
powershell -File scripts/docker-stop.ps1
```

Num checkout Git, o script de atualização para se houver alterações locais; sem alterações, faz `git pull --ff-only`, reconstrói as imagens, sobe os contêineres e espera a verificação de saúde. Ele não faz backup por você: rode `docker-backup.ps1` antes de atualizar e confira se o arquivo de backup apareceu de fato na pasta do host.

No Linux/macOS, use os comandos equivalentes:

```bash
# Backup online (o mesmo pedido que o docker-backup.ps1 envia)
curl --fail -X POST -H 'Content-Type: application/json' -d '{"label":"docker"}' http://127.0.0.1:4318/api/system/backups
# Atualização
git pull --ff-only
docker compose build --pull
docker compose up -d
# Parada
docker compose down
```

O `docker compose down` para e remove os contêineres, mas mantém os volumes nomeados. Depois de reiniciar, confira a quantidade de obras e as versões mais recentes do manuscrito antes de voltar a escrever.

Não use `docker compose down --volumes`, a menos que queira mesmo apagar todos os dados das obras.

A porta Web só escuta em `127.0.0.1`, a menos que você mude `NARRATIVE_WEB_BIND_HOST`. O token não protege essa porta: o Nginx o acrescenta a toda requisição para `/api`, então quem alcança a porta 4318 consegue usar a API. Antes de expor a porta na rede local ou na internet, coloque TLS e controle de acesso na frente (proxy reverso, VPN ou firewall), troque o token padrão por um valor de alta entropia e mantenha uma pasta de backup independente.

Mais variáveis de ambiente em [Configuração](configuration.md); passos de backup e restauração em [Dados, privacidade e backup](data-and-backup.md).
