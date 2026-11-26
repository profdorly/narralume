[Português](docker.md)

# Self-hosting with Docker Compose

Docker is the advanced self-hosting entry point in the source workspace; Docker Desktop or Docker Engine must be installed and running beforehand. The desktop release packages do not include the Docker build context.

Before starting, confirm:

- Docker Engine/Desktop is running with Docker Compose 2.24 or later (`docker-compose.yml` uses `env_file` with `required: false`);
- port 4318 is not used by another service;
- the repository root can hold a local-only `.env.local` and a `data/backups/` directory;
- if you plan to access it from other devices, TLS, a reverse proxy, access control, and an independent backup location are already in place.

On Windows, run:

```powershell
powershell -File scripts/docker-start.ps1
```

The script checks Docker, writes a random `NARRATIVE_AUTH_TOKEN` to a `.env` file at the repository root if there is none, starts Compose, waits for the health check, and opens a browser. You can also do it manually:

```bash
docker compose up -d --build
```

Visit `http://127.0.0.1:4318`. The Server does not publish a host port; Nginx proxies `/api` on the same origin and adds the authentication token. Works live on the `lapis-data` volume, and backups are written to `${NARRATIVE_BACKUP_HOST_DIR:-./data/backups}`.

Compose fills in `${NARRATIVE_AUTH_TOKEN}`, `${NARRATIVE_WEB_BIND_HOST}`, and `${NARRATIVE_BACKUP_HOST_DIR}` only from the shell or from a `.env` file at the repository root (Git and the Docker build ignore that file). `.env.local` is passed to the Server container, so it works for model keys and other Server variables, but it changes neither these three nor the values `docker-compose.yml` sets under `environment`: without a `.env` file or a shell variable, both containers use the default token `local-compose-token-change-me-24`. Earlier versions of `docker-start.ps1` wrote the token to `.env.local`, where it has no effect; run the script again to create `.env`. On Linux/macOS, create the token like this before the first `docker compose up`:

```bash
printf 'NARRATIVE_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
```

Check the runtime state:

```bash
docker compose ps
docker compose logs --tail 100 server web
```

The health endpoint is `http://127.0.0.1:4318/api/health`. Never paste tokens, model requests, or manuscript text from the logs into a public Issue.

Common maintenance entries on Windows:

```powershell
# Create an online consistency backup; files go to the separately mounted backups directory
powershell -File scripts/docker-backup.ps1
# Pull updates on a clean source workspace, rebuild, and wait for the health check
powershell -File scripts/docker-update.ps1
# Stop the containers but keep the data volumes
powershell -File scripts/docker-stop.ps1
```

In a Git checkout, the update script stops if there are local changes; otherwise it fast-forward pulls, rebuilds the images, starts the containers, and waits for the health check. It does not create a backup for you — run `docker-backup.ps1` before updating and confirm the backup file actually appears in the host directory.

On Linux/macOS, use the equivalent commands:

```bash
# Online backup (the same request docker-backup.ps1 sends)
curl --fail -X POST -H 'Content-Type: application/json' -d '{"label":"docker"}' http://127.0.0.1:4318/api/system/backups
# Update
git pull --ff-only
docker compose build --pull
docker compose up -d
# Stop
docker compose down
```

`docker compose down` stops and removes the containers but keeps the named volumes. After restarting, verify the work count and latest manuscript versions before continuing to write.

Do not use `docker compose down --volumes` unless you explicitly intend to delete all work data.

The Web port listens only on `127.0.0.1` unless you change `NARRATIVE_WEB_BIND_HOST`. The token does not protect that port: Nginx adds it to every `/api` request, so anyone who reaches port 4318 can use the API. Before exposing the port to a LAN or the public internet, put TLS and access control in front of it (a reverse proxy, VPN, or firewall), replace the default token with a high-entropy value, and keep an independent backup directory.

For more environment variables, see [Configuration](configuration.en.md); for backup and recovery steps, see [Data, privacy, and backup](data-and-backup.en.md).
