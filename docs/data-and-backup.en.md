[Português](data-and-backup.md)

# Data, Privacy, and Backup

Story line progress proposals and the decision on each item are stored in the current library and preserved by full SQLite backups. Story bundles and content snapshots keep the story compass with the accepted changes, but exclude the proposal and decision history. Make a full SQLite backup to retain the complete process.

Lapis does not provide cloud sync. Where your work actually lives depends on whether you use the browser local kernel, a local Server, or Docker; signing into the same browser account does not make this data interoperate automatically.

Start by telling the three file types and recovery paths apart:

| Object             | Scope                                       | Best for                                                                     | Contains model keys? |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------- | -------------------- |
| Story bundle       | One work                                    | Importing a work into another Lapis instance or handing it to a collaborator | No                   |
| Content snapshot   | One work, stored inside the current library | Marking a milestone you can later restore as a new project                   | No                   |
| Full SQLite backup | The entire library and local settings       | Disaster recovery before upgrades, machine migration, or clearing site data  | Possibly             |

A practical habit: create a content snapshot after finishing important chapters, make full backups regularly, and make one more full backup — plus a trial restore into a new directory — before any upgrade or migration. A synced drive can hold backup files, but syncing itself is not a recoverable backup.

## Browser local kernel

The browser local kernel is used when the page finds no Server answering at `/api/health`, or when you pick "Browser local kernel" under "Run driver" in Settings. If your library suddenly looks empty, check in that section which driver is in effect.

In this mode, works, the story compass, run history, and any bring-your-own model keys saved in the interface are stored in the OPFS SQLite database of the current browser and current site.

- Data is isolated per site; changing the domain or browser profile, or using a private window, may hide the original library.
- Clearing site data deletes the local library. Before clearing any cache, click "Download my library (.sqlite)" in Settings and confirm the downloaded file is readable.
- When the browser kernel calls a model directly, the upstream must allow CORS for the current site; this differs from the local Server's call chain.
- The browser library is not copied automatically into the release package's `data/`, and it does not sync just because you sign into the same account.

## Local Server and release launchers

By default the database is `data/lapis.sqlite`, and consistency backups are written to `data/backups/`. When the directory still has only `narralume.sqlite`, the Server renames that file, along with the `-wal` and `-shm` files beside it, to `lapis.sqlite` before opening it. When you start the Server yourself (for example with `npm run dev`), `NARRATIVE_DATA_DIR` and `NARRATIVE_BACKUP_DIR`, from the environment or from `.env.local`, change these directories; without `NARRATIVE_BACKUP_DIR`, backups go to `backups/` inside the data directory. The launchers set both variables themselves: the data directory comes from `LAPIS_DATA_DIR`, and backups go to `backups/` inside it. Only the macOS/Linux launcher also honors `NARRATIVE_DATA_DIR` and `NARRATIVE_BACKUP_DIR` set in the shell.

While the Server runs (Docker included), it makes an automatic backup every 6 hours (`NARRATIVE_BACKUP_INTERVAL_MINUTES`, default `360`), plus one at startup when `NARRATIVE_BACKUP_ON_STARTUP=true`. After each new backup, the directory keeps only the 10 most recent (`NARRATIVE_BACKUP_RETENTION`), counting both automatic and manual backups; copy any backup you need to keep longer somewhere else. Keep only files Lapis created in that directory: a `.sqlite` without a manifest or a leftover `.partial` makes listing and creating backups fail.

Do not copy the live SQLite main file while the service is running. Use "Back up now" under "System backup archives" in Settings, `scripts/backup.ps1` on Windows, `scripts/backup.sh` on macOS/Linux, or the Server's backup API (`POST /api/system/backups`); "Download my library (.sqlite)" only works with the browser local kernel. A Server backup is first written to a temporary file (`.partial`), passes SQLite's integrity and foreign-key checks, and only then gets its final name, next to a manifest (`.manifest.json`) that records its SHA-256; preview and restore verify that hash. A half-finished file is therefore never mistaken for a recoverable backup.

In a launcher release package:

- `data/` holds works and backups, and must be part of your personal backup plan.
- `.runtime/logs/` holds startup and error logs for diagnosing launch failures; it is not a data backup.
- Content snapshots do not contain provider channels or keys; a full SQLite backup may contain locally stored provider credentials.

## Docker volumes

Compose places the database on the `lapis-data` volume and mounts backups separately to `${NARRATIVE_BACKUP_HOST_DIR:-./data/backups}` on the host. To change that directory, set `NARRATIVE_BACKUP_HOST_DIR` in the shell or in a `.env` file at the repository root; it has no effect in `.env.local`. The volume itself is not a backup, and the backup directory must not sit on the same fragile disk as the only copy of the database.

Create an online backup:

```powershell
powershell -File scripts/docker-backup.ps1
```

Stop the service but keep the data:

```powershell
powershell -File scripts/docker-stop.ps1
```

Do not use `docker compose down --volumes` unless you explicitly intend to delete all work data and already hold a verified external backup.

## Content snapshots and story bundles: single-work recovery and migration

Fit for handing one work to a collaborator, making an experimental copy inside the same library, or leaving a readable milestone before delivery:

1. Open the project's "Delivery", fill in the "Backup label", and click "Create content snapshot".
2. In the snapshot list, confirm the label, time, and content counts.
3. To migrate, download "Story bundle" under "Export formats" (a `.narrative.json` file) and import it in the target environment; Markdown, plain text, DOCX, and EPUB are reading/delivery formats only.
4. To roll back, click "Restore content copy" on the snapshot's row, confirm the dialog, and open the new project with "Open the restored copy".
5. On the new project, verify the story compass, outline, latest manuscript versions, and comments. The original project is not overwritten, and run history is not carried into the copy.

The bundle downloaded from "Export formats" carries only the current version of each document, without version history, comments, or runs. A content snapshot keeps the version history and comments.

Content snapshots intentionally do not carry provider channels or keys. After a restore, configure and assign models again in the target environment's Settings if you need AI.

The current bundle format is version 6. It includes knowledge records, correction and withdrawal reasons, referenced historical facts, and voided events. Restoring and duplicating preserve chapter knowledge and revision chains without reactivating withdrawn claims. Older bundle formats are no longer supported: open the existing SQLite library with the current version, which upgrades the database at startup, and export a new bundle from it.

## Full SQLite backup: whole-library disaster recovery

Fit for before clearing browser site data, before upgrading a release package, before migrating machines, and for release-candidate acceptance:

1. Stop any operation that would modify the database, and create a full-library backup. For a running local Server, use "Back up now" under "System backup archives", `scripts/backup.ps1` on Windows, or `scripts/backup.sh` on macOS/Linux; with the browser local kernel, use "Download my library (.sqlite)" in Settings.
2. Record the backup file's SHA-256 and copy the file to encrypted storage or a controlled synced directory separate from the application directory. For Server backups, copy the `.sqlite` together with the `.manifest.json` of the same backup: the manifest records the SHA-256, and restoring from the interface needs it.
3. For Server backups, click "Preview" under "System backup archives" and confirm that "Hash check" shows "Match", "Integrity" shows `ok`, and "Foreign key violations" is 0.
4. For recovery, prepare a brand-new target directory; never overwrite the database of the running instance. In the preview, click "Restore to a new directory", enter the "Server target directory", and confirm with "Restore to target directory". The Server verifies the copy's hash and integrity, and refuses the current data directory, the backup directory, and any directory that already holds a database.
5. Start a test instance against the restored directory and check work count, latest manuscript versions, story compass, outline, comments, run history, and content snapshots.
6. Only after the drill passes, stop the production instance and point `NARRATIVE_DATA_DIR` (or `LAPIS_DATA_DIR` for the launchers) at the restored directory; keep the old directory until the new instance runs stably.

## How to confirm a backup is really usable

Do not settle for "the file exists". Regularly restore a full backup into a new test directory, then verify work count, latest manuscript versions, outline, confirmed facts, comments, and run history. Record the backup file name, creation time, SHA-256, application version, and restore directory. Clean up the test data only after the test instance checks out; the production data directory stays untouched.

Project maintainers should also check whether the restore left behind `.partial`, `.partial-shm`, or `.partial-wal` files, and keep one reviewable restore record for every release candidate.

Maintainers can first run `npm run test:release:recovery` to regress backup restore, orphaned-run interruption, and partial recovery contracts. For a release candidate, run `npm run verify:release`, which executes code verification, the full E2E suite, recovery regressions, and the real-model matrix in that order. These automated checks only verify encoded contracts; they do not replace the independent-directory restore drill and manual inspection above.

If a backup contains real model credentials, do not post the keys, the full database, or model responses to public Issues, CI artifacts, or screenshots, not even next to the backup's hash. For security incident handling, see [SECURITY.md](../SECURITY.md).
