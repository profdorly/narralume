[Português](quick-start.md)

# Quick Start

This page does one thing: get Lapis running, and make sure you know where your data lives. First-time users should start with the release package for their platform: it comes with a launcher and does not require installing Node.js. To self-host with Docker Compose from the source workspace, see [Docker Compose](docker.en.md); come back to the development section only if you plan to change code.

## Windows

Windows users can use the release package from [GitHub Releases](https://github.com/profdorly/narralume/releases) directly; no Node.js installation is required.

1. Download the latest Windows x64 ZIP.
2. Extract it to a writable directory, for example `D:\Lapis`.
3. Double-click `Start-Lapis.bat`.
4. The launcher opens your browser at `http://127.0.0.1:4317`, the default address; if it does not, open the address the launcher prints.

The launcher uses Node.js 24 or later if it is already installed. Otherwise, on first launch it downloads the official portable Node.js runtime (an internet connection is needed) and verifies its checksum before using it. If Windows SmartScreen reports an unknown publisher, confirm the ZIP came from the Releases page above, then click "More info" and "Run anyway".

Keep the launcher window open while you use Lapis: pressing Enter in that window, or closing it, stops Lapis.

Data is stored in `data/` inside the release directory by default: the `lapis.sqlite` database and the `backups/` folder. Never copy the SQLite file while Lapis is running. To move one work to another machine, export it as "Story bundle" in "Delivery". For the whole library, create a full backup with "Back up now" under "System backup archives" in "Settings", or with the backup script below; the backup is written to `data/backups/`.

The release directory contains two more folders. `.runtime/` holds the portable Node.js (when the launcher has to download it), the installed-dependencies marker, the server PID, and the logs; it is not work data. `scripts/` provides the start, stop, backup, and update scripts. While the app is running you can execute these in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
powershell -ExecutionPolicy Bypass -File scripts/stop.ps1
```

Environment variables can change the port and data directory:

```powershell
$env:LAPIS_PORT = "4321"
$env:LAPIS_DATA_DIR = "D:\Lapis-data"
.\Start-Lapis.bat
```

If you change the port, set the same `LAPIS_PORT` before running the backup script.

### Updating the Windows release

`UpdateAndStart-Lapis.bat` does not update a release package: it only reminds you to download the new release and keep the data directory, then starts the current version. Update by hand:

1. While the old version still opens, run `powershell -ExecutionPolicy Bypass -File scripts/backup.ps1`.
2. Run `powershell -ExecutionPolicy Bypass -File scripts/stop.ps1`, or press Enter in the launcher window, and confirm the service has stopped.
3. Extract the new ZIP into a fresh directory; do not overwrite the old version in place.
4. Copy the old directory's `data/` into the new directory in full; do not let the new package's empty `data/` overwrite the old database. If you keep your data outside the package with `LAPIS_DATA_DIR`, skip this step and start the new version with the same variable.
5. Start from the new directory and check the work count, the most recent prose, and the backup list. Only archive or delete the old directory after everything checks out.

## macOS

Apple Silicon users (M1 and later) can download `macos-arm64.tar.gz` from Releases; no preinstalled Node.js is required. There is no package for Intel Macs; on those, use Docker Compose or the source workspace.

1. Extract the release package and place the directory somewhere writable.
2. Double-click `Start-Lapis.command`, or run `./Start-Lapis.command` in a terminal.
3. The launcher opens your browser at `http://127.0.0.1:4317`.

If macOS blocks the first launch, confirm the package came from this project's GitHub Releases, then allow it in System Settings > Privacy & Security (up to macOS 14 you can also right-click the script in Finder and choose "Open"). The launcher uses Node.js 24 or later if it is already installed; otherwise it downloads and verifies the official Node.js arm64 runtime.

Lapis keeps running in the background after the launcher finishes. Back up and stop it with:

```bash
./scripts/backup.sh
./scripts/stop.sh
```

## Linux

The Linux release package targets x64 desktops or servers. After downloading `linux-x64.tar.gz` from Releases:

```bash
tar -xzf Lapis-*-linux-x64.tar.gz
cd Lapis-*/
./Start-Lapis.sh
```

The launcher needs `curl`. It uses Node.js 24 or later if it is already installed; otherwise it downloads and verifies the official Node.js x64 runtime, which also requires `tar` and `sha256sum` or `shasum`. On a graphical desktop it tries to open the browser; if it does not, visit the printed address. The launcher listens only on `127.0.0.1`: on a server without a desktop, use an SSH tunnel (for example `ssh -L 4317:127.0.0.1:4317 user@server`) and open the address on your own computer.

On macOS and Linux, data is stored in `data/` inside the release directory by default, and logs live in `.runtime/logs/`. The same launcher variables can be set before starting; the backup script reads `LAPIS_PORT` too:

```bash
export LAPIS_PORT=4321
export LAPIS_DATA_DIR="$HOME/Lapis-data"
./Start-Lapis.sh
```

`UpdateAndStart-Lapis.sh` (and `UpdateAndStart-Lapis.command` on macOS) does not update a release package either: it only reminds you to download the new release, then starts the current version. To update, run `./scripts/backup.sh` and `./scripts/stop.sh` first, extract the new version into a new directory, then copy the old directory's `data/` across in full. Never overwrite a directory in use or a running database directly.

## Development environment

The source workspace requires Node.js 24+ and npm 11+. See [CONTRIBUTING](../CONTRIBUTING.md) for the full contribution workflow. The most common commands are:

```bash
npm ci
npm run dev
npm run verify
```

`npm run verify` runs formatting, linting, type checks, tests, the evidence and retrieval evaluations, the license check, and the production build. Run it before committing at the very least, or state which checks could not run and why.

The development Web app listens on `http://127.0.0.1:4318`; the Server/API listens on `http://127.0.0.1:4317`. Data goes to `data/lapis.sqlite` at the repository root unless you set `NARRATIVE_DATA_DIR`. If you need environment variables, copy `.env.example` to `.env.local`; never commit real keys.

In a Git clone, `UpdateAndStart-Lapis.bat`, `.sh`, or `.command` runs `git pull --ff-only`, rebuilds, and starts Lapis through the launcher at `http://127.0.0.1:4317`. It stops if the checkout has local changes, and it does not make a backup.

## What to do after startup

1. Open "Shelf" and click "Blank book". You can create a book and write by hand without any model.
2. Enter "Story", fill in the author intent, then build the outline, entities, canon facts, relations, timeline, and foreshadows as needed.
3. Create chapter prose in "Writing"; when you want AI, create a provider and a model under "Provider and model management" in "Settings" and assign the model to the "Default generation model" role.
4. In "Delivery", review quality reminders, export the work, and create a content snapshot.

For the full feature walkthrough see the [user guide](user-guide.en.md); for environment variables and provider protocols see [Configuration](configuration.en.md); for backups and restores see [Data, privacy, and backup](data-and-backup.en.md).

## When startup fails

- Port in use: set `LAPIS_PORT` before starting the launcher, or stop the process occupying 4317/4318.
- The browser cannot open the page: on Windows, the launcher window must stay open. Running the launcher again is safe: if Lapis is already running, it just opens the browser. If startup fails, check `.runtime/logs/server-error.log`.
- Data directory not writable: point `LAPIS_DATA_DIR` (launcher) or `NARRATIVE_DATA_DIR` (source workspace with `npm run dev`) at a directory your user can write to.
- AI requests fail: check the provider protocol, Base URL, and key, and use "Probe" on the model card in "Settings". CORS only matters if you switched the "Run driver" to "Browser local kernel".
