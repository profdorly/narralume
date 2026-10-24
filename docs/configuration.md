[English](configuration.en.md)

# Configuração

A configuração tem duas camadas: provedores, modelos e atribuição de papéis na interface, que decidem "como este projeto chama um modelo"; e variáveis de ambiente do Server, que decidem "como o Server, o banco de dados, os backups e a rede funcionam". Termine primeiro a configuração na interface e só depois acrescente as variáveis de ambiente do seu modo de implantação: diagnosticar problemas fica muito mais simples nessa ordem.

## Configuração na interface: do provedor ao modelo padrão

Abra Configurações, expanda "Gestão de provedores e modelos" e siga esta ordem:

1. **Crie um provedor de modelo**: informe o nome, o protocolo, a `Base URL` e a chave. O campo de chave também aceita `env:NOME`, que lê o valor de uma variável de ambiente do processo do Server em vez de gravar a chave no banco.
2. **Crie um modelo**: informe o nome do modelo no provedor, o limite de contexto e o limite de saída. O nome precisa ser exatamente o que o provedor aceita; o nome exibido no produto serve só para reconhecimento.
3. **Atribua o papel**: escolha o modelo recém-criado em "Modelo padrão de geração". Escrita, planejamento e revisão o compartilham; substitua o papel de planejamento ou de revisão só quando realmente precisar de outro modelo. O modelo de embedding é configurado à parte, para a busca semântica, e não participa da geração de prosa (veja [Busca semântica e embeddings](#busca-semântica-e-embeddings)).
4. **Valide primeiro o fluxo manual**: volte à estante, crie um livro em branco e confirme que história, outline e estúdio de escrita funcionam antes de enviar uma proposta mínima de edição por IA. Assim você separa problemas de conexão com o modelo de problemas nos dados do produto.

Os protocolos suportados são OpenAI Chat Completions, OpenAI Responses e Anthropic Messages. A Base URL, os cabeçalhos de autenticação e os caminhos das requisições mudam por protocolo e são tratados pelo tipo de provedor; não cadastre um endpoint exclusivo da Anthropic como canal OpenAI Chat.

### Teste o modelo depois de cadastrá-lo

Use "Testar" no cartão do modelo depois de criá-lo e de novo depois de apontá-lo para outro modelo ou outro provedor, ou de mudar a Base URL, o endpoint ou a API do provedor: essas edições apagam as marcas gravadas por um teste anterior. Mudar `NARRATIVE_*_MODEL` ou `NARRATIVE_*_BASE_URL` de um modelo de ambiente apaga as marcas do mesmo jeito na próxima inicialização. Tarefas já em andamento continuam com a configuração com que começaram. O teste verifica texto, streaming, ferramentas e saída estruturada e grava os resultados como marcas de capacidade do modelo. Toda requisição de teste usa o formato das tarefas de capítulo: esforço de raciocínio `low` com `temperature` e limite de saída de 1024 tokens, para que modelos de raciocínio tenham espaço para responder. O teste nunca envia `top_p`: as tarefas de capítulo não o enviam, e alguns modelos o rejeitam junto com `temperature`.

A etapa de texto também detecta restrições da requisição. Alguns modelos (por exemplo, os modelos de raciocínio da OpenAI) rejeitam `temperature`/`top_p`, alguns só no esforço de raciocínio enviado pelas tarefas de capítulo, gateways que convertem o esforço de raciocínio em pensamento estendido da Anthropic só aceitam `temperature` igual a 1, e, no Chat Completions, alguns modelos rejeitam `max_tokens` e exigem `max_completion_tokens`. Quando a mensagem de erro do provedor cita o parâmetro rejeitado, o teste ajusta a requisição, informa o ajuste no detalhe da etapa e testa as etapas seguintes com a requisição ajustada. Quando o provedor aceita a requisição ajustada, o teste grava `samplingParameters: false` ou `maxCompletionTokens: true` (este só para provedores Chat Completions), mesmo que a resposta depois falhe na verificação de texto. `samplingParameters` é medido só com `temperature`: `true` não diz nada sobre `top_p`, e `false` faz as tarefas omitirem tanto `temperature` quanto `top_p`. Uma rejeição com outra redação falha a etapa de texto sem gravar nenhuma das marcas. Tarefas iniciadas depois do teste omitem os parâmetros de amostragem ou enviam `max_completion_tokens`. Uma tarefa que já chamou o modelo mantém o que congelou para aquele tipo de chamada; inicie a tarefa de novo depois do teste.

Enquanto o modelo não for testado essas marcas ficam desconhecidas, e as requisições continuam enviando `temperature`, `top_p` e `max_tokens`. Se uma tarefa falhar com um erro dizendo que o modelo rejeita um deles, teste o modelo e inicie a tarefa de novo. O teste mede com esforço de raciocínio `low`; se uma tarefa com outro esforço, ou um modelo cujas configurações de amostragem acrescentam `top_p`, receber uma rejeição citando um parâmetro que o teste aceitou, o erro informa que a evidência do teste não cobre aquela requisição. Um modelo que rejeita o parâmetro de esforço de raciocínio ou o valor `low` falha na etapa de texto, porque as tarefas de capítulo, de importação e as demais tarefas narrativas também o enviam. O teste então envia a requisição de texto e as etapas restantes sem esforço de raciocínio, para que as marcas de streaming, ferramentas, saída estruturada e formato da requisição descrevam requisições sem ele (como o assistente com raciocínio desligado) em vez de repetir a rejeição. Isso depende de a mensagem de erro do provedor citar o esforço de raciocínio. Uma rejeição com outra redação falha a etapa de texto, as etapas de streaming, ferramentas e saída estruturada continuam enviando o esforço de raciocínio e falham com o mesmo erro, e o teste grava `streaming`, `tools` e `structuredOutput` como `false`, mesmo que o modelo os suporte; as marcas de formato da requisição ficam como estavam. Se todas as etapas falharem com o mesmo erro, corrija a configuração do provedor ou do modelo (por exemplo, o ID do modelo ou as configurações de raciocínio do gateway) e teste de novo.

## Diferença entre o kernel do navegador e o Server local

| Quem chama                | Onde a chave fica guardada                          | Exigência do provedor                                          | Indicado para                                     |
| ------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| Kernel local do navegador | Banco OPFS do site atual                            | O provedor permite CORS no navegador                           | Uso em uma máquina, só no navegador (local-first) |
| Server local              | Variáveis de ambiente do Server ou o banco local    | O Server alcança o provedor; o CORS do navegador não interfere | Pacotes de release para desktop, código-fonte     |
| Server em Docker          | `.env.local`, banco montado ou variáveis do Compose | O contêiner alcança o provedor                                 | Implantação local ou self-hosted                  |

O site no navegador e o Server local são dois drivers de dados independentes. Chaves configuradas em um modo não aparecem no outro. Antes de apagar os dados do site no navegador, baixe a biblioteca SQLite completa em Configurações.

## Variáveis de ambiente do Server

Copie o modelo e mantenha-o só nesta máquina:

```bash
cp .env.example .env.local
```

O `.env.local` nunca deve ir para o Git. Variáveis comuns:

| Variável                                                           | Padrão/faixa                 | Função                                                                                   |
| ------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `NARRATIVE_LLM_BASE_URL`                                           | `https://api.example.com/v1` | Base URL do provedor padrão; o valor de exemplo precisa ser trocado                      |
| `NARRATIVE_LLM_API_KEY`                                            | Vazio                        | Chave do provedor padrão; as variáveis específicas de protocolo também funcionam         |
| `NARRATIVE_LLM_MODEL`                                              | Vazio                        | Nome padrão do modelo no provedor                                                        |
| `NARRATIVE_LLM_CONTEXT_WINDOW` / `NARRATIVE_LLM_MAX_OUTPUT_TOKENS` | Vazio                        | Limites de contexto e de saída do modelo padrão                                          |
| `NARRATIVE_CHAT_*`                                                 | Vazio                        | Substituições para o protocolo OpenAI Chat                                               |
| `NARRATIVE_RESPONSES_*`                                            | Vazio                        | Substituições para o protocolo OpenAI Responses                                          |
| `NARRATIVE_ANTHROPIC_*`                                            | Vazio                        | Substituições para o protocolo Anthropic Messages                                        |
| `NARRATIVE_MODEL_PRICING_JSON`                                     | Vazio                        | Preços opcionais dos modelos, para estimar o custo das tarefas                           |
| `NARRATIVE_DATA_DIR`                                               | `./data`                     | Pasta do banco SQLite                                                                    |
| `NARRATIVE_BACKUP_DIR`                                             | `./data/backups`             | Pasta dos backups consistentes; prefira outro disco ou uma pasta sincronizada            |
| `NARRATIVE_BACKUP_RETENTION`                                       | `10`, faixa 1-100            | Quantos backups automáticos são mantidos                                                 |
| `NARRATIVE_BACKUP_INTERVAL_MINUTES`                                | `360`, faixa 5-43200         | Intervalo do backup automático                                                           |
| `NARRATIVE_BACKUP_ON_STARTUP`                                      | `false`                      | Se o Server faz um backup assim que inicia                                               |
| `NARRATIVE_SERVER_HOST`                                            | `127.0.0.1`                  | Endereço de escuta; escutar na rede exige configuração extra de segurança                |
| `NARRATIVE_SERVER_PORT`                                            | `4317`                       | Porta da API e do serviço de produção na mesma origem                                    |
| `NARRATIVE_ALLOW_REMOTE`                                           | `false`                      | Se aceita acesso fora do loopback; token e TLS são obrigatórios antes de expor o serviço |
| `NARRATIVE_AUTH_TOKEN`                                             | Vazio                        | Token de acesso remoto, com pelo menos 24 caracteres                                     |
| `NARRATIVE_STATIC_DIR`                                             | Vazio                        | Pasta dos arquivos estáticos da Web no modo de produção                                  |

Os launchers de release têm mais três variáveis, que só afetam o launcher: `NARRALUME_PORT` muda a porta local, `NARRALUME_DATA_DIR` muda a pasta de dados e `NARRALUME_NODE_VERSION` escolhe a versão portátil do Node.js. Elas não são variáveis gerais do Server; os launchers de Windows, macOS e Linux repassam os valores finais ao Server. No uso normal, só as duas primeiras costumam ser necessárias.

## Variáveis específicas do Docker

O Compose lê o `.env.local` e o ambiente do shell:

- `NARRATIVE_AUTH_TOKEN`: o valor de exemplo só serve para testes locais; troque-o por um token de alta entropia antes de a máquina sair da sua mesa.
- `NARRATIVE_WEB_BIND_HOST`: padrão `127.0.0.1`. Mudar para `0.0.0.0` publica a porta Web em todas as interfaces de rede; não faça isso sem TLS, controle de acesso na rede e backups independentes.
- `NARRATIVE_BACKUP_HOST_DIR`: pasta de backup independente no host, padrão `./data/backups`, montada em `/app/backups` dentro do contêiner.

Dentro do contêiner, o Server escuta em `0.0.0.0` com o modo remoto ligado, como a rede de contêineres exige. A partir do host, o acesso passa só pela Web/Nginx; a porta do Server não é publicada diretamente.

## Busca semântica e embeddings

Quando a IA escreve um capítulo (inclusive na Criação rápida com IA), o NarraLume procura no manuscrito anterior os trechos mais relacionados à tarefa e os acrescenta ao contexto do modelo, ao lado do outline, da Bíblia da História e do capítulo anterior.

- **Índice**: cada capítulo e cena ligado ao outline é dividido em trechos de cerca de 380 tokens que nunca atravessam uma quebra de cena (`* * *`). Cada trecho é ligado aos personagens, lugares e objetos da Bíblia da História que ele cita. O índice é atualizado ao registrar uma versão, aceitar uma proposta ou importar um manuscrito, e antes de toda tarefa de IA (o que também cobre backups restaurados e bibliotecas antigas).
- **Sinais**: a busca combina palavras (um índice de texto completo que ignora acentos e flexões comuns; texto em chinês mantém o índice por caracteres), os personagens previstos no plano do capítulo e, quando há um modelo de embedding atribuído, a semelhança entre vetores. São usados no máximo dois trechos por capítulo, e o capítulo anterior nunca é recuperado porque já está inteiro no contexto. A consulta do capítulo usa o título, o plano (resumo, objetivo, conflito, desfecho), os personagens previstos e as notas de direção; um capítulo sem plano usa o resumo do capítulo anterior. Preencha o resumo no outline para melhores resultados.
- **Modelo de embedding**: atribua um modelo do tipo "Embedding" ao papel "Embedding" em Configurações. Ele nunca é herdado do modelo de escrita. Sem ele, a busca usa só palavras e personagens, e cada tarefa registra um evento `run.degraded`. Os vetores são criados ao registrar a prosa e, para os trechos que ainda não têm vetor (uma importação, uma edição aceita em outro lugar, uma troca de modelo), no início da próxima escrita de capítulo por IA, até 512 trechos por tarefa. Só os trechos cujo texto mudou ganham vetor novo; trocar de modelo não perde a busca, só custa uma passada pelo livro.
- **Situação**: o Laboratório narrativo mostra quantos capítulos estão indexados, quantos trechos têm vetor do modelo atribuído e um botão "Reindexar agora". A variável `NARRATIVE_EMBEDDING_MODEL` não é mais lida; o Server registra um aviso se ela ainda estiver definida.
- **Medição**: `npm run test:retrieval` roda a avaliação offline da busca (`evals/retrieval-v1.json`: dois livros de exemplo, em português e em inglês) e falha quando a qualidade cai abaixo do piso. `npm run eval:retrieval:real` roda os mesmos casos com um modelo de embedding real compatível com a OpenAI, enviando só o texto dos exemplos, usando `NARRATIVE_EVAL_EMBEDDING_API_KEY` (ou `NARRATIVE_LLM_API_KEY`) e, se quiser, `NARRATIVE_EVAL_EMBEDDING_BASE_URL`. Acrescente `--index=chapter` para comparar com o índice anterior, de um segmento por capítulo.

### Reordenação com a Decisions API (opcional)

Com um modelo atribuído ao papel "Reordenação da busca (opcional)", a busca entrega até 32 trechos candidatos e a [Decisions API da OpenAI](https://developers.openai.com/api/docs/guides/decisions) lê cada um ao lado do que vai ser escrito e estima a probabilidade de quem escreve precisar dele. Entram no contexto os 8 mais prováveis (no máximo dois por capítulo); trechos abaixo de 5% ficam de fora. A reordenação só escolhe entre o que a busca encontrou: sem a busca por palavras, personagens e embeddings não há candidatos.

- **Onde vale**: escrita de capítulos por IA, inclusive na Criação rápida com IA. A busca do Laboratório narrativo não usa a reordenação. (A cocriação também usa, mas está fora da v1.)
- **Como ativar**: em "Gestão de provedores e modelos", num provedor OpenAI (Chat Completions ou Responses, Base URL `https://api.openai.com/v1`), adicione o modelo `gpt-6-luna` com o tipo de tarefa "Reordenação". "Testar" envia uma pergunta à Decisions API. Depois, em "Papéis avançados", atribua o modelo a "Reordenação da busca (opcional)".
- **Custo e privacidade**: a Decisions API cobra só a entrada, US$ 0,10 por milhão de tokens (preço de outubro de 2026). Com 32 trechos de cerca de 450 tokens, isso dá perto de US$ 0,0015 por capítulo. Os trechos candidatos são enviados à OpenAI a cada capítulo escrito por IA.
- **Falhas**: se a chamada falhar, a tarefa continua com a ordem da busca e registra um evento `run.degraded` (capacidade `rerank`).
- **Medição**: `npm run eval:retrieval:real -- --reranker=decisions` acrescenta a linha `hybrid+rerank` à avaliação da busca, enviando só o texto dos livros de exemplo.

## Falhas comuns de configuração

- **Há modelos, mas as tarefas dizem que não existe modelo padrão**: volte ao papel "Modelo padrão de geração" e atribua de novo; desativar um modelo ou provedor também remove as atribuições dele.
- **O navegador mostra erro de CORS**: confirme que o provedor permite a origem Web atual; com o Server local, confirme que as requisições passam pelo Server e não saem direto do navegador.
- **401/403**: confira a origem da chave, o tipo de protocolo e a Base URL do provedor, e nunca cole uma chave completa em uma Issue.
- **O Server remoto não inicia**: com `NARRATIVE_ALLOW_REMOTE=true` também é preciso um `NARRATIVE_AUTH_TOKEN` de pelo menos 24 caracteres, além de controle de acesso na camada de TLS ou proxy reverso.
- **Variáveis de ambiente sem efeito depois de uma atualização**: confirme que o processo iniciado lê o `.env.local` da nova pasta e reinicie o Server; um processo em execução não recarrega as variáveis de ambiente.
