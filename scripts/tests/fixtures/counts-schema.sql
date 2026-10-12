-- iconclass-counts.db schema for the fixture DB. Regenerate after a rebuild and review the diff:
--   node scripts/tests/build-fixture-db.mjs --capture
-- version_info at capture:
--   schema_version = 3
--   release_tag = counts-latest
--   built_at = 2026-06-13T09:42:58.888108+00:00
--   collection_count = 1
--   total_notation_counts = 22787

CREATE TABLE collection_counts (
            collection_id TEXT NOT NULL,
            notation      TEXT NOT NULL,
            count         INTEGER NOT NULL,
            PRIMARY KEY (collection_id, notation)
        ) WITHOUT ROWID;

CREATE TABLE collection_info (
            collection_id        TEXT PRIMARY KEY,
            label                TEXT NOT NULL,
            counts_as_of         TEXT,
            total_notations      INTEGER DEFAULT 0,
            search_url_template  TEXT
        );

CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX idx_counts_notation ON collection_counts(notation, collection_id);
