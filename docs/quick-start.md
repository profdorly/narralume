[English](quick-start.en.md)

# Início rápido

Esta página resolve uma coisa só: colocar o NarraLume para rodar e mostrar onde ficam os seus dados. Se é a primeira vez, comece pelo pacote de release da sua plataforma: ele vem com um launcher e não exige instalar o Node.js. Para hospedar com Docker Compose a partir do código-fonte, veja [Docker Compose](docker.md); o ambiente de desenvolvimento só interessa se você for mudar o código.

## Windows

No Windows, use o pacote de release do [GitHub Releases](https://github.com/profdorly/narralume/releases); não é preciso instalar o Node.js.

1. Baixe o ZIP mais recente para Windows x64.
2. Extraia o ZIP numa pasta em que você tenha permissão de escrita, por exemplo `D:\NarraLume`.
3. Dê um duplo clique em `Start-NarraLume.bat`.
4. O launcher abre o navegador em `http://127.0.0.1:4317`, o endereço padrão; se isso não acontecer, abra o endereço que ele mostra.

O launcher usa o Node.js 24 ou mais recente, se já estiver instalado. Se não estiver, na primeira inicialização ele baixa o runtime portátil oficial do Node.js (é preciso internet) e confere o checksum antes de usá-lo. Se o Windows SmartScreen avisar que o editor é desconhecido, confirme que o ZIP veio da página de Releases acima e clique em "Mais informações" e depois em "Executar assim mesmo".

Deixe a janela do launcher aberta enquanto usa o NarraLume: apertar Enter nessa janela, ou fechá-la, encerra o NarraLume.

Por padrão, os dados ficam em `data/`, dentro da pasta do pacote: o banco `narralume.sqlite` e a pasta `backups/`. Nunca copie o arquivo SQLite com o NarraLume em execução. Para levar uma obra a outra máquina, exporte o "Pacote da história" em "Entrega". Para a biblioteca inteira, crie um backup completo com "Fazer backup agora", em "Configurações" > "Arquivos de backup do sistema", ou com o script de backup abaixo; o backup é gravado em `data/backups/`.

A pasta do pacote tem mais duas pastas. `.runtime/` guarda o Node.js portátil (quando o launcher precisa baixá-lo), o marcador das dependências instaladas, o PID do servidor e os logs; não são dados das obras. `scripts/` traz os scripts de início, parada, backup e atualização. Com o NarraLume rodando, você pode executar no PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
powershell -ExecutionPolicy Bypass -File scripts/stop.ps1
```

Variáveis de ambiente mudam a porta e a pasta de dados:

```powershell
$env:NARRALUME_PORT = "4321"
$env:NARRALUME_DATA_DIR = "D:\NarraLume-data"
.\Start-NarraLume.bat
```

Se mudar a porta, defina o mesmo `NARRALUME_PORT` antes de rodar o script de backup.

### Atualizar o pacote para Windows

O `UpdateAndStart-NarraLume.bat` não atualiza um pacote de release: ele só lembra de baixar o release novo e preservar a pasta de dados, e inicia a versão atual. Atualize à mão:

1. Com a versão antiga ainda funcionando, rode `powershell -ExecutionPolicy Bypass -File scripts/backup.ps1`.
2. Rode `powershell -ExecutionPolicy Bypass -File scripts/stop.ps1`, ou aperte Enter na janela do launcher, e confirme que o serviço parou.
3. Extraia o ZIP novo numa pasta nova; não sobrescreva a versão antiga.
4. Copie a pasta `data/` inteira da pasta antiga para a nova; não deixe a `data/` vazia do pacote novo sobrescrever o banco antigo. Se você guarda os dados fora do pacote com `NARRALUME_DATA_DIR`, pule este passo e inicie a versão nova com a mesma variável.
5. Inicie pela pasta nova e confira o número de obras, a prosa mais recente e a lista de backups. Só arquive ou apague a pasta antiga depois de tudo conferido.

## macOS

Em Macs com Apple Silicon (M1 ou mais recente), baixe o `macos-arm64.tar.gz` em Releases; não é preciso ter o Node.js instalado. Não há pacote para Macs com processador Intel: neles, use o Docker Compose ou o código-fonte.

1. Extraia o pacote e coloque a pasta num lugar com permissão de escrita.
2. Dê um duplo clique em `Start-NarraLume.command` ou rode `./Start-NarraLume.command` no Terminal.
3. O launcher abre o navegador em `http://127.0.0.1:4317`.

Se o macOS bloquear a primeira abertura, confirme que o pacote veio do GitHub Releases do projeto e autorize a abertura em Ajustes do Sistema > Privacidade e Segurança (até o macOS 14, também funciona clicar no script com o botão direito, no Finder, e escolher Abrir). O launcher usa o Node.js 24 ou mais recente, se já estiver instalado; se não, baixa e confere o runtime oficial do Node.js para arm64.

O NarraLume continua rodando em segundo plano depois que o launcher termina. Para fazer backup e parar o serviço:

```bash
./scripts/backup.sh
./scripts/stop.sh
```

## Linux

O pacote para Linux é para x64, em desktop ou servidor. Depois de baixar o `linux-x64.tar.gz` em Releases:

```bash
tar -xzf NarraLume-*-linux-x64.tar.gz
cd NarraLume-*/
./Start-NarraLume.sh
```

O launcher precisa do `curl`. Ele usa o Node.js 24 ou mais recente, se já estiver instalado; se não, baixa e confere o runtime oficial do Node.js para x64, o que também exige `tar` e `sha256sum` ou `shasum`. Num desktop gráfico, ele tenta abrir o navegador; se não abrir, acesse o endereço mostrado. O launcher só escuta em `127.0.0.1`: num servidor sem interface gráfica, use um túnel SSH (por exemplo, `ssh -L 4317:127.0.0.1:4317 usuario@servidor`) e abra o endereço no seu computador.

No macOS e no Linux, os dados ficam por padrão em `data/`, dentro da pasta do pacote, e os logs em `.runtime/logs/`. As mesmas variáveis do launcher podem ser definidas antes de iniciar; o script de backup também lê `NARRALUME_PORT`:

```bash
export NARRALUME_PORT=4321
export NARRALUME_DATA_DIR="$HOME/NarraLume-data"
./Start-NarraLume.sh
```

O `UpdateAndStart-NarraLume.sh` (e, no macOS, o `UpdateAndStart-NarraLume.command`) também não atualiza um pacote de release: ele só lembra de baixar o release novo e inicia a versão atual. Para atualizar, rode antes `./scripts/backup.sh` e `./scripts/stop.sh`, extraia a versão nova numa pasta nova e copie a pasta `data/` inteira da pasta antiga. Nunca sobrescreva uma pasta em uso nem um banco em execução.

## Ambiente de desenvolvimento

O código-fonte exige Node.js 24+ e npm 11+. O fluxo completo de contribuição está em [Como contribuir](../CONTRIBUTING.md). Os comandos mais usados são:

```bash
npm ci
npm run dev
npm run verify
```

O `npm run verify` roda formatação, lint, checagem de tipos, testes, as avaliações de evidência e de busca, a checagem de licenças e o build de produção. Rode-o pelo menos antes de cada commit, ou informe quais checagens não puderam rodar e por quê.

No desenvolvimento, a Web fica em `http://127.0.0.1:4318` e o Server (API) em `http://127.0.0.1:4317`. Os dados vão para `data/narralume.sqlite`, na raiz do repositório, a menos que você defina `NARRATIVE_DATA_DIR`. Se precisar de variáveis de ambiente, copie `.env.example` para `.env.local`; nunca faça commit de chaves reais.

Numa cópia clonada com Git, o `UpdateAndStart-NarraLume.bat`, `.sh` ou `.command` roda `git pull --ff-only`, refaz o build e inicia o NarraLume pelo launcher em `http://127.0.0.1:4317`. Ele para se houver mudanças locais e não faz backup.

## Depois de iniciar

1. Abra a "Estante" e clique em "Livro em branco". Dá para criar o livro e escrever à mão sem nenhum modelo.
2. Entre em "História", preencha a intenção da autoria e, conforme precisar, monte a estrutura, as entidades, os fatos, as relações, a linha do tempo e as antecipações.
3. Escreva os capítulos em "Escrita". Para usar IA, crie um provedor e um modelo em "Gestão de provedores e modelos", nas "Configurações", e atribua o modelo ao papel "Modelo padrão de geração".
4. Em "Entrega", confira as checagens de qualidade, exporte a obra e crie um instantâneo do conteúdo.

O passo a passo completo está no [guia do usuário](user-guide.md); as variáveis de ambiente e os protocolos dos provedores, em [Configuração](configuration.md); backup e restauração, em [Dados, privacidade e backup](data-and-backup.md).

## Quando a inicialização falha

- Porta ocupada: defina `NARRALUME_PORT` antes de iniciar o launcher, ou encerre o processo que ocupa a 4317/4318.
- O navegador não abre a página: no Windows, a janela do launcher precisa continuar aberta. Rodar o launcher de novo é seguro: se o NarraLume já estiver rodando, ele só abre o navegador. Se a inicialização falhar, veja `.runtime/logs/server-error.log`.
- Pasta de dados sem permissão de escrita: aponte `NARRALUME_DATA_DIR` (launcher) ou `NARRATIVE_DATA_DIR` (código-fonte com `npm run dev`) para uma pasta em que seu usuário possa gravar.
- As requisições de IA falham: confira o protocolo, a Base URL e a chave do provedor e use "Testar" no cartão do modelo, em "Configurações". O CORS só importa se você mudou o "Driver de execução" para "Núcleo local no navegador".
