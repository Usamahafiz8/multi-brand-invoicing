-- Cursor for incremental pull-from-Zoho (FR-ZHO-030). NULL means "never
-- pulled" — the first pull for a brand fetches everything.
ALTER TABLE "integration_connection" ADD COLUMN "last_pulled_at" TIMESTAMP(3);
