-- Router PostgreSQL schema v1

CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS data_migrations (
    name TEXT PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS llm_knowledge_bases (
    kb_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    match_prompt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_knowledge_bases (
    kb_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS qa_documents (
    kb_type TEXT NOT NULL CHECK (kb_type IN ('llm', 'rag')),
    kb_id TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kb_type, kb_id)
);

CREATE TABLE IF NOT EXISTS qa_items (
    kb_type TEXT NOT NULL CHECK (kb_type IN ('llm', 'rag')),
    kb_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    question TEXT NOT NULL,
    variants JSONB NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (kb_type, kb_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_items_kb ON qa_items (kb_type, kb_id);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operation_logs (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    module TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL DEFAULT '',
    kb_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'log',
    extra JSONB
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_ts ON operation_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_module ON operation_logs (module);
CREATE INDEX IF NOT EXISTS idx_operation_logs_kb_id ON operation_logs (kb_id);

CREATE TABLE IF NOT EXISTS recall_tests (
    kb_type TEXT NOT NULL CHECK (kb_type IN ('llm', 'rag')),
    kb_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    question TEXT NOT NULL DEFAULT '',
    recalled TEXT NOT NULL DEFAULT '',
    run_at TIMESTAMPTZ,
    last_top_id TEXT,
    last_confidence REAL,
    notes TEXT,
    match_profile_id TEXT,
    model_label TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    PRIMARY KEY (kb_type, kb_id, row_id)
);

CREATE INDEX IF NOT EXISTS idx_recall_tests_kb ON recall_tests (kb_type, kb_id);

CREATE TABLE IF NOT EXISTS rag_runtime_configs (
    kb_id TEXT PRIMARY KEY REFERENCES rag_knowledge_bases (kb_id) ON DELETE CASCADE,
    config JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_index_meta (
    kb_id TEXT PRIMARY KEY REFERENCES rag_knowledge_bases (kb_id) ON DELETE CASCADE,
    meta JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_eval_runs (
    kb_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (kb_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_runs_kb_created ON rag_eval_runs (kb_id, created_at DESC);
