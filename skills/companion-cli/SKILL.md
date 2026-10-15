---
name: companion-cli
description: Build or change pages, buttons, triggers, custom variables, connections or surfaces on a local Bitfocus Companion 5.1 install with companion-cli description files; also read what an install holds, and press buttons or read variables on a running Companion.
---

# companion-cli

`companion-cli` writes Companion's database from YAML description files, with Companion stopped, and reads it from a snapshot copy. Run it as `companion-cli` (after `npm link` in its repository) or `node dist/bin/companion-cli.js` from the repository after `npm run build`.

The facts live in the tool, not here: `companion-cli schema` is the description format (every kind, field and default), `companion-cli schema --connection <label>` a connection's module actions and feedbacks, `companion-cli --help` the commands and flags. The repository's `README.md` explains each command, and `docs/support-matrix.md` lists what the format covers of Companion's stored content.

## Platforms

- **macOS:** everything. Without `--db` (live-install mode), commands target the install's database.
- **Elsewhere:** pass `--db <path>` to read commands and `validate`; `validate --no-db` and `schema` work anywhere. `schema --connection` checks the app in `/Applications` and needs macOS. Apply on macOS only, for now: off macOS, `apply --db` cannot yet tell whether Companion is running. Windows support is in progress.

## Which command

| Task | Command |
| --- | --- |
| Discover what exists | `companion-cli list variables` (also `triggers`, `connections`, `pages`, `surfaces`) |
| Locate what uses a variable, connection or text | `companion-cli find --variable <name>`, `--connection <label>`, `"<text>"` |
| Start from what is stored | `companion-cli export page <n>` (also `variables`, `trigger`, `triggers`, `connection`, `surface`; `--button <row>/<column>` for one cell) |
| Check a file | `companion-cli validate <file>` |
| Preview the change | `companion-cli apply <file> --dry-run --json` |
| Write it | `companion-cli apply <file>` |
| Exercise it on the running Companion | `companion-cli press <page> <row> <column>` (also `down`, `up`, `rotate-left`, `rotate-right`), `companion-cli variable get <name>`, `companion-cli variable set <name> <value>`, `companion-cli surface list`, `companion-cli surface get <id>` |
| Format reference | `companion-cli schema`, `companion-cli schema --connection <label>` |

## The loop

1. **Read.** `list`, then `find` for whatever the change touches. Read commands write nothing and never stop Companion; run them freely.
2. **Export, then edit.** Start from `export` of the thing you are changing (YAML, without `--json`), never a blank file. One thing per file: a page, a button, a trigger (or a triggers list), a variables list, a connection, a surface. Each apply replaces exactly what its file names and nothing else.
3. **Author.** Look fields up in `schema`. Pass-through actions and feedbacks are written as given and not checked, so take their definition ids and options from `schema --connection <label>`. Custom variables must exist before a button or trigger names them: apply the variables file first. Local variables have three entry forms (see `schema`); every `$(local:…)` reference must name one of that control's local variables, and validate and apply check this. Connection secrets come only from environment variables, never from the file.
4. **Validate.** `companion-cli validate <file> --json` until it passes. Map the error's `path` (such as `buttons[3].down[0].variable`) back to the file and act on its `hint`. `--unchecked` lets unverifiable connection or surface config keys through with a warning: use it only when the user agrees.
5. **Dry run.** `companion-cli apply <file> --dry-run --json`. It writes nothing and works while Companion runs. Read `tables` (rows added, changed, removed) and `summary`. Check the change is exactly the one you meant. Generated ids never count as changes, so a button reported replaced really differs; the text report (without `--json`) names up to three stored paths per replaced cell that say where.
6. **Ask, then apply.** Show the user the dry run's summary and the blast radius, and get a yes. In live-install mode (no `--db`, macOS) `apply` quits Companion, backs up, writes and starts Companion again. For experiments, apply to a copy with `--db <copy>` instead.
7. **Verify.** Re-run the dry run: it reports `no changes` (`changed: false`) once the file is applied. Read the result back with `list`, `find` or `export`, then exercise it with `press` and `variable get`.

## Reading results

- Pass `--json` to every command whose output you parse; `export` without it gives the YAML file to edit. Exit codes: 0 success, 1 failure, 2 bad command line.
- With `--json`, a failure is one document on stdout: `{"error": {"code", "message", "path", "hint", …}}`. Act on `hint`; the codes are listed in the README.
- A real apply prints `applied`, `summary`, `backup` and `rest`. `rest: "timeout"` comes with a `REST not ready` warning and exit 0: the write is committed. Wait a moment and retry the runtime command; leave the apply alone. `rest: "not_configured"` means apply did not wait, so check Companion answers before pressing.
- An error with `committed: true` (`restart_failed`) also means the write landed: start Companion, do not re-apply.
- `export_unsupported` means the stored content is outside what the format covers. Check `docs/support-matrix.md`, tell the user, and leave that item as Companion stores it.

## Name patterns

`list`, `find` and `export` take the same case-sensitive globs: `*` any run, `?` one character, over the whole name. Quote them so the shell leaves them alone: `companion-cli list variables 'skaarhoj_*'`.

## Safety

- Ask before every apply in live-install mode. Each one restarts Companion.
- Leave Companion's database file to the tool: read it through `list`, `find` and `export`, write it through `apply`.
- Only local installs. `COMPANION_URL` must point at localhost.

## Backups and undo

Every real apply copies the database and its WAL files to `companion-cli-backups/<timestamp>/` next to the database and prints the path (`backup` in JSON). Note it. To undo, follow the README's **Undo** steps exactly, with the user: they include the WAL files, and skipping that step lets a newer WAL replay onto the restored database.
