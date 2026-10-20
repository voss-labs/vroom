import { createHash, randomBytes } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { CliError, databaseError } from "./mod-errors";

type Sql = NeonQueryFunction<false, false>;

export interface SessionConfig {
  origin: string;
  databaseUrl: string;
}

interface Session {
  id: string;
  hash: string;
  token: string;
  deadline: number;
}

interface SessionOptions {
  sql?: Sql;
  now?: () => number;
  timeoutMs?: number;
  warning?: (message: string) => void;
}

const INSERT = `INSERT INTO cli_sessions (token_hash, origin)
  VALUES ($1, $2)
  RETURNING id, created_at, expires_at, statement_timestamp() AS db_now`;

export const REVOKE_WARNING =
  "CLI session revocation could not be confirmed. Its fixed expiry still applies.";

export class ModSession {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly sql: Sql;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly warning: (message: string) => void;
  private readonly secrets: string[];
  private current: Session | undefined;
  private stopped = false;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly config: SessionConfig,
    options: SessionOptions = {},
  ) {
    this.signal = this.controller.signal;
    this.now = options.now ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.warning = options.warning ?? ((message) => console.error(message));
    this.secrets = [config.databaseUrl];
    try {
      this.sql = options.sql ?? neon(config.databaseUrl);
    } catch {
      throw new CliError(
        "DATABASE_URL has an invalid format.",
        false,
        [],
        true,
      );
    }
  }

  redact(text: string): string {
    return this.secrets.reduce(
      (value, secret) => value.replaceAll(secret, "[redacted]"),
      text,
    );
  }

  private async database<T>(
    task: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error());
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve(task(controller.signal)),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw databaseError(error, timedOut);
    } finally {
      clearTimeout(timer);
    }
  }

  private material(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    this.secrets.push(token);
    return { token, hash: createHash("sha256").update(token).digest("hex") };
  }

  private accept(
    row: Record<string, unknown> | undefined,
    material: { token: string; hash: string },
    started: number,
  ): void {
    if (!row) {
      throw new CliError(
        "The CLI session was revoked or removed. Restart the CLI to register a new session.",
        false,
        [],
        true,
      );
    }
    const expiry = new Date(row.expires_at as string).getTime();
    const dbNow = new Date(row.db_now as string).getTime();
    const created = new Date(row.created_at as string).getTime();
    if (
      typeof row.id !== "string" ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(row.id) ||
      !Number.isFinite(expiry) ||
      !Number.isFinite(dbNow) ||
      !Number.isFinite(created) ||
      expiry - created !== 900_000
    ) {
      throw new CliError(
        "The database returned invalid CLI session metadata.",
        false,
        [],
        true,
      );
    }
    this.current = {
      ...material,
      id: row.id,
      deadline: started + expiry - dbNow,
    };
  }

  async start(): Promise<void> {
    this.assertOpen();
    if (this.current) return;
    const material = this.material();
    const started = this.now();
    this.pending = (async () => {
      const rows = await this.database((signal) =>
        this.sql.query(INSERT, [material.hash, this.config.origin], {
          fetchOptions: { signal },
        }),
      );
      this.accept(rows[0], material, started);
    })();
    await this.pending;
    if (this.stopped) return;
    try {
      await this.database((signal) =>
        this.sql.query(
          `DELETE FROM cli_sessions WHERE id IN (
          SELECT id FROM cli_sessions
          WHERE expires_at <= statement_timestamp() - INTERVAL '7 days'
             OR revoked_at <= statement_timestamp() - INTERVAL '7 days'
          ORDER BY LEAST(expires_at, revoked_at) ASC, id ASC LIMIT 100
        )`,
          [],
          { fetchOptions: { signal } },
        ),
      );
    } catch {
      this.warning("Old CLI session cleanup could not be completed.");
    }
  }

  private assertOpen(): void {
    if (this.stopped)
      throw new CliError("The CLI session has ended.", false, [], true);
  }

  async token(): Promise<string> {
    this.assertOpen();
    if (!this.current)
      throw new CliError("The CLI session has not started.", false, [], true);
    if (this.current.deadline - this.now() < 30_000) await this.renew();
    this.assertOpen();
    return this.current.token;
  }

  async renew(): Promise<void> {
    this.assertOpen();
    const old = this.current;
    if (!old)
      throw new CliError("The CLI session has not started.", false, [], true);
    const material = this.material();
    const started = this.now();
    this.pending = (async () => {
      const results = await this.database((signal) =>
        this.sql.transaction(
          (tx) => [
            tx.query(
              "SELECT id FROM cli_sessions WHERE id = $1 AND token_hash = $2 FOR UPDATE",
              [old.id, old.hash],
            ),
            tx.query(
              `INSERT INTO cli_sessions (token_hash, origin)
           SELECT $1, $2 FROM cli_sessions
           WHERE id = $3 AND token_hash = $4 AND revoked_at IS NULL
           RETURNING id, created_at, expires_at, statement_timestamp() AS db_now`,
              [material.hash, this.config.origin, old.id, old.hash],
            ),
            tx.query(
              `UPDATE cli_sessions SET revoked_at = statement_timestamp()
           WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM cli_sessions WHERE token_hash = $3)`,
              [old.id, old.hash, material.hash],
            ),
          ],
          { fetchOptions: { signal } },
        ),
      );
      this.accept(results[1]?.[0], material, started);
    })();
    await this.pending;
  }

  revoke(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    this.closing ??= (async () => {
      await this.pending?.catch(() => undefined);
      const current = this.current;
      if (!current) return;
      try {
        await this.database((signal) =>
          this.sql.query(
            `UPDATE cli_sessions SET revoked_at = statement_timestamp()
           WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
            [current.id, current.hash],
            { fetchOptions: { signal } },
          ),
        );
      } catch {
        this.warning(REVOKE_WARNING);
      }
    })();
    return this.closing;
  }
}
