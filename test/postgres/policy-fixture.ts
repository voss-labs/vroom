import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { userInfo } from "node:os";
import type { Query } from "drizzle-orm";

export const schema = `vroom_policy_${randomUUID().replaceAll("-", "")}`;
export const memberId = "00000000-0000-0000-0000-000000000001";

export function runSql(
  script: string,
  options: { scope?: boolean; onStderr?: (chunk: string) => void } = {},
): Promise<string> {
  const socket = process.env.VROOM_POLICY_PG_SOCKET;
  const port = process.env.VROOM_POLICY_PG_PORT;
  if (
    !socket ||
    !isAbsolute(socket) ||
    !port ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  ) {
    throw new Error(
      "Set VROOM_POLICY_PG_SOCKET to an absolute local socket directory and VROOM_POLICY_PG_PORT to its port.",
    );
  }
  const username = process.env.VROOM_POLICY_PG_USER ?? userInfo().username;
  const args = [
    "--no-psqlrc",
    "--no-password",
    "--quiet",
    "--tuples-only",
    "--no-align",
    "--set=ON_ERROR_STOP=1",
    `--host=${socket}`,
    `--port=${port}`,
    "--dbname=postgres",
    `--username=${username}`,
  ];
  const setup = `SET statement_timeout = '8s'; SET lock_timeout = '4s'; SET standard_conforming_strings = on; ${options.scope === false ? "" : `SET search_path TO "${schema}";`}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG")) delete env[key];
  }
  env.PGCONNECT_TIMEOUT = "5";
  env.PGPASSFILE = `/private/tmp/${schema}.pgpass`;
  return new Promise((resolve, reject) => {
    const child = spawn("psql", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      options.onStderr?.(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`PostgreSQL fixture failed: ${stderr}`)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(`${setup}\n${script}`);
  });
}

function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("Unsupported policy query parameter.");
}

export function prepared(query: Query): string {
  return `PREPARE materialize_policy AS ${query.sql}; EXECUTE materialize_policy(${query.params.map(literal).join(", ")}); DEALLOCATE materialize_policy;`;
}

export async function state(): Promise<{
  reports: number;
  audits: number;
  suspended: boolean;
  updates: number;
}> {
  const output = await runSql(`SELECT json_build_object(
    'reports', (SELECT count(*) FROM reports),
    'audits', (SELECT count(*) FROM moderation_audit),
    'suspended', (SELECT suspended_at IS NOT NULL FROM members WHERE id = '${memberId}'),
    'updates', (SELECT n FROM member_updates)
  );`);
  return JSON.parse(output) as {
    reports: number;
    audits: number;
    suspended: boolean;
    updates: number;
  };
}

export const fixtureSql = `
  CREATE TABLE members (id uuid PRIMARY KEY, suspended_at timestamptz, suspended_reason text);
  CREATE TABLE reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id text NOT NULL, message_id text NOT NULL,
    reported_member_id uuid NOT NULL REFERENCES members(id), reporter_member_id uuid,
    message_snapshot text NOT NULL, reason text, author_handle text
  );
  CREATE UNIQUE INDEX reports_auto_flag_uniq ON reports(room_id, message_id) WHERE reporter_member_id IS NULL;
  CREATE TABLE moderation_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL, actor_member_id uuid,
    actor_kind text NOT NULL CHECK (actor_kind IN ('console', 'script')), target_type text NOT NULL,
    target_id text, report_id uuid REFERENCES reports(id), details jsonb
  );
  CREATE TABLE member_updates(n integer NOT NULL);
  CREATE FUNCTION injected_write_failure() RETURNS trigger LANGUAGE plpgsql AS $trigger$
  BEGIN
    IF current_setting('vroom.test_fault', true) = TG_TABLE_NAME THEN
      RAISE EXCEPTION 'injected failure on %', TG_TABLE_NAME;
    END IF;
    IF TG_TABLE_NAME = 'members' AND current_setting('vroom.test_fault', true) = 'pause' THEN
      RAISE NOTICE 'policy-materialization-waiting';
      PERFORM pg_sleep(0.5);
    END IF;
    RETURN NEW;
  END;
  $trigger$;
  CREATE TRIGGER fail_member_write BEFORE UPDATE ON members FOR EACH ROW EXECUTE FUNCTION injected_write_failure();
  CREATE TRIGGER fail_audit_write BEFORE INSERT ON moderation_audit FOR EACH ROW EXECUTE FUNCTION injected_write_failure();
  CREATE FUNCTION count_member_write() RETURNS trigger LANGUAGE plpgsql AS $counter$
  BEGIN
    UPDATE member_updates SET n = n + 1;
    RETURN NEW;
  END;
  $counter$;
  CREATE TRIGGER count_member_writes AFTER UPDATE ON members FOR EACH ROW EXECUTE FUNCTION count_member_write();
`;
