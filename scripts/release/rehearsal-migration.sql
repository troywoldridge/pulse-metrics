-- Phase 2E3C5D3: Test-only transactional canary SQL.
-- NEVER apply against the working installation or production.
-- The release runner owns BEGIN/COMMIT and includes receipt insertion in
-- the SAME transaction. No SQL in this file changes the public schema.
CREATE TABLE pulse_release_rehearsal.applied_canary (
  id integer PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO pulse_release_rehearsal.applied_canary (id, description)
VALUES (1, 'synthetic approved release');
