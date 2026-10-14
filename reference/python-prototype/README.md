# Python prototype (reference only)

Two scripts written on 2026-10-14 while building a test page for the SKAARHOJ Raw Panel surface plugin. They are the source of truth for the Companion 5.1 shapes in [docs/companion-internals.md](../../docs/companion-internals.md) until the CLI exists. Do not extend them; the CLI replaces them.

## `fill_page20.py`

`python3 fill_page20.py /path/to/db.sqlite`

Writes a 47-button SKAARHOJ PTZ Extreme test page into page 20 of a Companion 5.1 database, with Companion stopped:

- Deletes the controls currently placed on page 20, inserts new `button-layered` controls with fresh ids, and rewrites the `pages` row `20` (keeping its internal `id`).
- Creates or replaces 12 custom variables (`sk_presses`, `sk_last`, `sk_enc1`..`sk_enc8`, `sk_iris`, `sk_focus`), keeping existing `sortOrder` values.
- Buttons increment `sk_presses` and set `sk_last`; encoders count their variable up and down and reset on push; one button is a two-step latch using the `bank_current_step` feedback.
- Runs in one transaction. It does not stop Companion, take a backup, check the DB version or run an integrity check; those were done by hand. It requires the `pages` row `20` to exist already.

Applied to a real Companion 5.1.0 install; verified over REST that presses increment counters and encoders count.

## `verify.py`

`python3 verify.py before.sqlite after.sqlite`

Diffs two database copies and asserts the script changed only page 20, its new controls and the 12 variables; checks the expected positions; compares each new control's JSON key paths with existing controls made by Companion. It is pinned to one database snapshot: it hard-codes two reference control ids (`bank:EcAicmU5ReMbt07HSVKMT`, `bank:WH7Chi4rlLVcbpXKX0SxI`) from that install, so it will not run against another database as is.
