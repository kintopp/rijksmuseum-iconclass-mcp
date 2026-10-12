-- iconclass.db schema for the fixture DB. Regenerate after a rebuild and review the diff:
--   node scripts/tests/build-fixture-db.mjs --capture
-- version_info at capture:
--   built_at = 2026-04-03T05:58:54.903535+00:00
--   iconclass_data_commit = f6aae630d8ae43ae2f145dfc1bb0c92eb2274411
--   notation_count = 1346371
--   base_notation_count = 39802
--   key_expanded_count = 1306569
--   text_languages = cz,de,en,es,fi,fr,hu,it,jp,nl,pl,pt,zh
--   keyword_languages = cz,de,en,es,fi,fr,it,jp,nl,pt,zh
--   schema_version = 3
--   release_tag = 0.3.0

CREATE TABLE keywords (
            notation TEXT NOT NULL,
            lang     TEXT NOT NULL,
            keyword  TEXT NOT NULL
        );

CREATE VIRTUAL TABLE keywords_fts USING fts5(
            keyword,
            content=keywords,
            content_rowid=rowid
        );

CREATE TABLE notations (
            notation       TEXT PRIMARY KEY,
            path           TEXT NOT NULL,
            children       TEXT NOT NULL,
            refs           TEXT NOT NULL,
            base_notation  TEXT,
            key_id         TEXT,
            is_key_expanded INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;

CREATE TABLE texts (
            notation TEXT NOT NULL,
            lang     TEXT NOT NULL,
            text     TEXT NOT NULL
        );

CREATE VIRTUAL TABLE texts_fts USING fts5(
            text,
            content=texts,
            content_rowid=rowid
        );

CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX idx_keywords_notation_lang ON keywords(notation, lang);

CREATE INDEX idx_notations_base ON notations(base_notation) WHERE base_notation IS NOT NULL;

CREATE INDEX idx_notations_prefix ON notations(notation);

CREATE INDEX idx_texts_notation_lang ON texts(notation, lang);
