[中文](configuration.md)

# Configuration

Configuration has two layers: provider channels, models, and role assignments in the product interface, which decide "how this project calls a model"; and server-side environment variables, which decide "how the Server, database, backups, and network run". Finish the interface configuration first, then add environment variables for your deployment mode — troubleshooting is much simpler in that order.

## Interface configuration: from channels to the default model

Open Settings and expand "Provider and model management", then work in this order:

1. **Create a model provider**: enter the provider name, protocol, `Base URL`, and key. The key field also accepts `env:NAME`, which reads the value from an environment variable of the process running the Server instead of writing the key into the database.
2. **Create a model**: enter the upstream model name, context limit, and output limit. The model name must be the exact value the upstream accepts; the in-product display name is only for recognition.
3. **Assign the role**: pick the model you just created under "Default generation model". Writing, planning, and review all share it; override the planning or review role only when you genuinely need a different model. The embedding model is configured separately for semantic search and does not take part in prose generation.
4. **Accept with the manual pipeline first**: go back to the bookshelf, create a blank book, and confirm that Story, outline, and the writing studio all work before sending one minimal AI edit proposal. This separates model connectivity problems from product data problems.

The supported upstream protocols are OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. The Base URL, authentication headers, and request paths differ per protocol and are handled by the provider type; do not register an Anthropic-only endpoint as an OpenAI Chat channel.

### Probe a model after adding it

Use "Probe" on the model card after creating a model, and again after pointing it at a different upstream model or Provider, or after changing its Provider's Base URL, endpoint, or wire API; those edits clear the flags an earlier probe recorded. Changing an environment model's `NARRATIVE_*_MODEL` or `NARRATIVE_*_BASE_URL` clears them the same way at the next start. Runs already in progress keep the configuration they started with. The probe checks text, streaming, tools, and structured output, and stores the results as the model's capability flags. Every probe request uses the shape of chapter tasks: reasoning effort `low` together with `temperature`, and an output limit of 1024 tokens so reasoning models have room to answer. The probe never sends `top_p`: chapter tasks do not send it, and some models reject it together with `temperature`.

The text stage also detects request constraints. Some models (for example OpenAI reasoning models) reject `temperature`/`top_p`, some only at the reasoning effort chapter tasks send, gateways that turn the reasoning effort into Anthropic extended thinking accept no `temperature` other than 1, and on Chat Completions some models reject `max_tokens` in favor of `max_completion_tokens`. When the provider's error message names the rejected parameter, the probe adjusts the request, reports the adjustment in the stage detail, and probes the remaining stages with the adjusted request. Once the provider accepts an adjusted request, the probe records `samplingParameters: false` or `maxCompletionTokens: true` (the latter only for Chat Completions providers), even if the reply then fails the text check. `samplingParameters` is measured with `temperature` only: `true` says nothing about `top_p`, and `false` makes runs omit both `temperature` and `top_p`. A rejection worded differently fails the text stage without recording either flag. Runs started after the probe omit sampling parameters or send `max_completion_tokens`. A run that has already called the model keeps the settings it froze for that kind of call, so start the task again after probing.

Until a model has been probed these flags are unknown and requests keep sending `temperature`, `top_p`, and `max_tokens`. If a task fails with an error saying the model rejects one of them, probe the model and start the task again. The probe measures at reasoning effort `low`; if a task that uses another effort, or a model whose sampling settings add `top_p`, gets a rejection naming a parameter the probe accepted, the error says the probe evidence does not cover that request. A model that rejects the reasoning effort parameter or the value `low` fails the text stage, because chapter, import, and other narrative tasks send it too. The probe then sends the text request and the remaining stages without a reasoning effort, so the streaming, tools, structured-output, and request-shape flags describe requests without one (such as the assistant with reasoning turned off) instead of repeating the rejection. This relies on the provider's error message naming the reasoning effort. A rejection worded differently fails the text stage, the streaming, tools, and structured-output stages still send the reasoning effort and fail with the same error, and the probe records `streaming`, `tools`, and `structuredOutput` as `false` even though the model may support them; the request-shape flags are left unchanged. If every stage fails with the same error, fix the Provider or model configuration (for example the model ID or the gateway's reasoning settings) and probe again. The public demo Relay and the Bridge only forward `max_tokens`, so a model that requires `max_completion_tokens` is not supported through them.

## Difference between the browser kernel and the local Server

| Caller               | Key storage location                                   | Upstream requirement                                        | Best for                                             |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------- |
| Browser local kernel | Current site's OPFS database                           | Upstream allows browser CORS                                | Hosted demo, single-machine browser local-first work |
| Local Server         | Server environment variables or the local database     | Server can reach the upstream; not affected by browser CORS | Desktop release packages, production source launches |
| Docker Server        | `.env.local`, a mounted database, or Compose variables | Container can reach the upstream                            | Local or self-hosted deployments                     |

The browser site and the local Server are two independent data drivers. Keys configured in one mode do not automatically appear in the other. Before clearing site data on the hosted demo, download the full SQLite library from Settings.

## Server-side environment variables

Copy the template and keep it only on this machine:

```bash
cp .env.example .env.local
```

`.env.local` must never be committed to Git. Common variables:

| Variable                                                           | Default/range                | Purpose                                                                                                      |
| ------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `NARRATIVE_LLM_BASE_URL`                                           | `https://api.example.com/v1` | Base URL of the default provider channel; the placeholder must be replaced                                   |
| `NARRATIVE_LLM_API_KEY`                                            | Empty                        | Key for the default provider channel; protocol-specific variables also work                                  |
| `NARRATIVE_LLM_MODEL`                                              | Empty                        | Default upstream model name                                                                                  |
| `NARRATIVE_LLM_CONTEXT_WINDOW` / `NARRATIVE_LLM_MAX_OUTPUT_TOKENS` | Empty                        | Context and output limit metadata for the default model                                                      |
| `NARRATIVE_CHAT_*`                                                 | Empty                        | Overrides for the OpenAI Chat protocol                                                                       |
| `NARRATIVE_RESPONSES_*`                                            | Empty                        | Overrides for the OpenAI Responses protocol                                                                  |
| `NARRATIVE_ANTHROPIC_*`                                            | Empty                        | Overrides for the Anthropic Messages protocol                                                                |
| `NARRATIVE_EMBEDDING_MODEL`                                        | Empty                        | Optional OpenAI-compatible embedding model; without it, retrieval falls back to full-text and entity signals |
| `NARRATIVE_MODEL_PRICING_JSON`                                     | Empty                        | Optional model pricing metadata for run-cost estimation                                                      |
| `NARRATIVE_DATA_DIR`                                               | `./data`                     | SQLite database directory                                                                                    |
| `NARRATIVE_BACKUP_DIR`                                             | `./data/backups`             | Consistency backup directory; an independent disk or synced directory is recommended                         |
| `NARRATIVE_BACKUP_RETENTION`                                       | `10`, range 1-100            | Number of backups kept automatically                                                                         |
| `NARRATIVE_BACKUP_INTERVAL_MINUTES`                                | `360`, range 5-43200         | Automatic backup interval                                                                                    |
| `NARRATIVE_BACKUP_ON_STARTUP`                                      | `false`                      | Whether to back up immediately when the Server starts                                                        |
| `NARRATIVE_SERVER_HOST`                                            | `127.0.0.1`                  | Listen address; remote listening requires extra security configuration                                       |
| `NARRATIVE_SERVER_PORT`                                            | `4317`                       | API / same-origin production service port                                                                    |
| `NARRATIVE_ALLOW_REMOTE`                                           | `false`                      | Whether to allow non-loopback access; a token and TLS are mandatory before any public exposure               |
| `NARRATIVE_AUTH_TOKEN`                                             | Empty                        | Remote access token, at least 24 characters                                                                  |
| `NARRATIVE_STATIC_DIR`                                             | Empty                        | Directory for serving Web static files in production mode                                                    |

The release launchers have three more variables that affect only the launcher: `NARRALUME_PORT` changes the local listen port, `NARRALUME_DATA_DIR` changes the data directory, and `NARRALUME_NODE_VERSION` selects the portable Node.js version. They are not general Server environment variables; the Windows, macOS, and Linux launchers pass their final values to the Server. Normal use usually only needs the first two.

## Docker-specific variables

Compose reads `.env.local` and the shell environment:

- `NARRATIVE_AUTH_TOKEN`: the default example value is only acceptable for local trials; replace it with a high-entropy token before the machine leaves your desk.
- `NARRATIVE_WEB_BIND_HOST`: defaults to `127.0.0.1`. Changing it to `0.0.0.0` publishes the Web port on every network interface; do not do this without TLS, network ACLs, and independent backups.
- `NARRATIVE_BACKUP_HOST_DIR`: an independent host backup directory, defaulting to `./data/backups`, mapped to `/app/backups` inside the container.

The Docker Server listens on `0.0.0.0` inside the container with remote mode enabled, which container networking requires. From the host, access goes through the Web/Nginx only; the Server port is not published directly.

## Bridge / Relay

Bridge and Relay are optional generic upstream proxies. Ordinary users do not need them: browser mode can call a CORS-permitting upstream directly, and the local Server or Docker can call the upstream server-side. You only need to run a Bridge on your machine when maintaining a public hosted demo and the Cloudflare Relay must reach a model service on your own PC or private network.

This advanced path is: `browser → Web → Relay → Tunnel/Access → local Bridge → upstream model`. The Bridge only forwards; it is not a work database, an account system, or a required backend for ordinary users. The deployer still defines the domain, origin allowlist, rate limits, logging, and secret injection.

The Bridge needs these variables:

```text
UPSTREAM_BASE_URL=https://api.example.com/v1
UPSTREAM_API_KEY=replace-me
UPSTREAM_MODEL=replace-me
BRIDGE_SHARED_SECRET=replace-with-at-least-24-characters
BRIDGE_PORT=4320
BRIDGE_MAX_CONCURRENCY=8
BRIDGE_UPSTREAM_TIMEOUT_MS=600000
```

The Relay's public variables specify the Bridge address, the model, and the single allowed Web Origin:

```text
UPSTREAM_BASE_URL=https://api.example.com/v1
RELAY_MODEL=replace-me
WEB_ORIGIN=https://app.example.com
```

`api.example.com`, `app.example.com`, and `replace-me` are placeholders.

## Common configuration failures

- **Models exist, but tasks report no default model**: go back to the "Default generation model" role and reassign it; disabling a model or provider also removes its assignments.
- **Browser reports CORS errors**: confirm the channel address allows the current Web Origin; when using the local Server, confirm requests go through the Server rather than a direct browser connection.
- **401/403**: check the key source, protocol type, and upstream Base URL, and never paste a full key into an Issue.
- **Remote Server fails to start**: with `NARRATIVE_ALLOW_REMOTE=true` you must also set a `NARRATIVE_AUTH_TOKEN` of at least 24 characters and enforce access control at the TLS/reverse-proxy layer.
- **Environment variables not taking effect after an upgrade**: confirm the process actually launched reads the `.env.local` in the new directory, and restart the Server; a running process does not reload environment variables automatically.
