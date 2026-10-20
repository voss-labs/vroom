CREATE TABLE IF NOT EXISTS cli_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '15 minutes'),
  revoked_at timestamptz
);

ALTER TABLE cli_sessions
  DROP CONSTRAINT IF EXISTS cli_sessions_token_hash,
  DROP CONSTRAINT IF EXISTS cli_sessions_origin,
  DROP CONSTRAINT IF EXISTS cli_sessions_lifetime,
  DROP CONSTRAINT IF EXISTS cli_sessions_revocation,
  ADD CONSTRAINT cli_sessions_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT cli_sessions_origin CHECK (origin ~ '[^[:space:]]'),
  ADD CONSTRAINT cli_sessions_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  ADD CONSTRAINT cli_sessions_revocation CHECK (revoked_at IS NULL OR revoked_at >= created_at);

CREATE INDEX IF NOT EXISTS cli_sessions_expires_at_idx ON cli_sessions(expires_at);

CREATE OR REPLACE FUNCTION guard_cli_session() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := statement_timestamp();
    NEW.expires_at := NEW.created_at + interval '15 minutes';
    NEW.revoked_at := NULL;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
      OR NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'CLI session credentials and lifetime are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'CLI session revocation is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      NEW.revoked_at := statement_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS cli_sessions_guard ON cli_sessions;
CREATE TRIGGER cli_sessions_guard BEFORE INSERT OR UPDATE ON cli_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_cli_session();

REVOKE ALL ON TABLE cli_sessions FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_cli_session() FROM PUBLIC;

DO $privileges$
DECLARE
  session_table regclass := format('%I.cli_sessions', current_schema())::regclass;
  granted_role record;
BEGIN
  FOR granted_role IN
    SELECT DISTINCT roles.rolname
    FROM pg_catalog.pg_class AS tables
    CROSS JOIN LATERAL aclexplode(tables.relacl) AS privileges
    JOIN pg_catalog.pg_roles AS roles ON roles.oid = privileges.grantee
    WHERE tables.oid = session_table AND privileges.grantee <> tables.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', session_table, granted_role.rolname);
  END LOOP;
END;
$privileges$;
