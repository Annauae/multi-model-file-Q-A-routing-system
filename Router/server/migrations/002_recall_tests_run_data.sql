-- Persist full recall-test run results (answers, timings, RAG sources, etc.)
ALTER TABLE recall_tests
    ADD COLUMN IF NOT EXISTS run_data JSONB NOT NULL DEFAULT '{}'::jsonb;
