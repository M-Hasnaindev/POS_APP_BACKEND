# Owner authorization boundaries

Before changing any remote database or server, obtain explicit user approval for that concrete action. This includes creating databases/tables, running migrations, altering procedures/configuration, cleanup/shrink/restart, environment changes, and deployments. Ordinary code edits and local tests do not authorize those operations.

CHERRYS_APP_SYNC was deleted by the owner. Do not recreate it or replace it with another server-side sync store. Keep sync state on the client; preserve original source data and the last completed local snapshot on failure.
