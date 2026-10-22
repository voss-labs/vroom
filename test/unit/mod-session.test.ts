import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, safeError } from "../../scripts/mod-client";
import { REVOKE_WARNING } from "../../scripts/mod-session";
import {
  config,
  databaseUrl,
  metadata,
  nextSessionId,
  sessionHarness,
  sessionId,
} from "./mod-session-helpers";

afterEach(() => vi.useRealTimers());

describe("database CLI session registration", () => {
  it("inserts only a random credential hash and canonical origin, taking lifetime from the database", async () => {
    const { session, query } = sessionHarness();
    await session.start();
    const token = await session.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO cli_sessions (token_hash, origin)");
    expect(sql).toContain("statement_timestamp() AS db_now");
    expect(sql).not.toContain("SELECT 1");
    expect(params).toEqual([
      createHash("sha256").update(token).digest("hex"),
      config.origin,
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(token);
    expect(JSON.stringify(query.mock.calls)).not.toContain(databaseUrl);
    expect(query.mock.calls[0][2]?.fetchOptions?.signal).toBeInstanceOf(
      AbortSignal,
    );
    await session.revoke();
  });

  it.each([
    ["42501", "permission"],
    ["25006", "permission"],
    ["42P01", "migration is missing"],
    ["42703", "migration is missing"],
    ["28P01", "connection could not be completed"],
    ["unknown", "connection could not be completed"],
  ])(
    "maps structured driver code %s to a fixed safe error",
    async (code, message) => {
      const { session, query } = sessionHarness();
      query.mockRejectedValue({
        code,
        message: databaseUrl,
        detail: databaseUrl,
        cause: new Error(databaseUrl),
      });
      const error = await session.start().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CliError);
      expect(safeError(error)).toContain(message);
      expect(safeError(error)).not.toContain(databaseUrl);
      expect(query).toHaveBeenCalledOnce();
    },
  );

  it("bounds a hung driver and aborts its HTTP signal", async () => {
    vi.useFakeTimers();
    const { session, query } = sessionHarness(50);
    query.mockImplementation(() => new Promise(() => undefined));
    const result = session.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(safeError(await result)).toBe("The database request timed out.");
    expect(query.mock.calls[0][2]?.fetchOptions?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses bounded seven-day terminal cleanup independently of registration authority", async () => {
    const { session, query, warning } = sessionHarness();
    query
      .mockResolvedValueOnce([metadata()])
      .mockRejectedValueOnce(new Error(databaseUrl));
    await session.start();
    expect(await session.token()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cleanup = query.mock.calls[1][0];
    expect(cleanup).toContain("DELETE FROM cli_sessions");
    expect(cleanup).toContain(
      "expires_at <= statement_timestamp() - INTERVAL '7 days'",
    );
    expect(cleanup).toContain(
      "revoked_at <= statement_timestamp() - INTERVAL '7 days'",
    );
    expect(cleanup).toContain(
      "ORDER BY LEAST(expires_at, revoked_at) ASC, id ASC LIMIT 100",
    );
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "Old CLI session cleanup could not be completed.",
    );
    expect(warning.mock.calls.flat().join()).not.toContain(databaseUrl);
    query.mockResolvedValue([]);
    await session.revoke();
  });
});

describe("CLI session freshness", () => {
  it("uses the database clock and monotonic elapsed time despite workstation wall clock skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01"));
    const { session, clock, transaction } = sessionHarness();
    await session.start();
    const original = await session.token();
    clock.value += 870_000;
    expect(await session.token()).toBe(original);
    expect(transaction).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("1900-01-01"));
    clock.value += 1;
    expect(await session.token()).not.toBe(original);
    expect(transaction).toHaveBeenCalledOnce();
    await session.revoke();
  });

  it("subtracts registration request duration when deciding freshness", async () => {
    const { session, query, clock, transaction } = sessionHarness();
    query.mockImplementationOnce(async () => {
      clock.value += 10_000;
      return [metadata()];
    });
    await session.start();
    clock.value += 860_001;
    await session.token();
    expect(transaction).toHaveBeenCalledOnce();
    await session.revoke();
  });

  it("renews after an expired idle menu with a lock, new row and predecessor revocation in one transaction", async () => {
    const { session, clock, batches, query } = sessionHarness();
    await session.start();
    const old = await session.token();
    clock.value += 900_001;
    const token = await session.token();
    expect(token).not.toBe(old);
    const batch = batches[0];
    expect(batch).toHaveLength(3);
    expect(batch[0].text).toContain("FOR UPDATE");
    expect(batch[0].params).toEqual([
      sessionId,
      createHash("sha256").update(old).digest("hex"),
    ]);
    expect(batch[1].text).toContain("revoked_at IS NULL");
    expect(batch[1].text).not.toContain("expires_at >");
    expect(batch[1].text).not.toContain("UPDATE");
    expect(batch[1].params[0]).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(batch[2].text).toContain("SET revoked_at = statement_timestamp()");
    expect(batch[2].text).toContain("AND EXISTS");
    expect(JSON.stringify(batch)).not.toContain(token);
    expect(JSON.stringify(batch)).not.toContain(old);
    expect(session.redact(`${old} ${token} ${databaseUrl}`)).toBe(
      "[redacted] [redacted] [redacted]",
    );
    await session.revoke();
    expect(query.mock.calls.at(-1)?.[1]?.[0]).toBe(nextSessionId);
  });

  it.each(["revoked", "missing"])(
    "stops a %s session instead of registering around it",
    async () => {
      const { session, transaction, query } = sessionHarness();
      await session.start();
      transaction.mockResolvedValueOnce([[], [], []]);
      const error = await session.renew().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ fatal: true });
      expect(safeError(error)).toContain("revoked or removed");
      expect(
        query.mock.calls.filter(([text]) => text.startsWith("INSERT")),
      ).toHaveLength(1);
      await session.revoke();
    },
  );

  it("retains the in-memory predecessor when the rotation transaction rolls back", async () => {
    const { session, transaction } = sessionHarness();
    await session.start();
    const original = await session.token();
    transaction.mockRejectedValueOnce({ code: "42501", message: original });
    await expect(session.renew()).rejects.toThrow("permission");
    expect(await session.token()).toBe(original);
    await session.revoke();
  });
});

describe("CLI session teardown", () => {
  it("revokes only the current id and hash once and prevents future requests", async () => {
    const { session, query } = sessionHarness();
    await session.start();
    const token = await session.token();
    await Promise.all([session.revoke(), session.revoke()]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]).toEqual([
      expect.stringContaining(
        "WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL",
      ),
      [sessionId, createHash("sha256").update(token).digest("hex")],
      { fetchOptions: { signal: expect.any(AbortSignal) } },
    ]);
    expect(session.signal.aborted).toBe(true);
    await expect(session.token()).rejects.toMatchObject({ fatal: true });
  });

  it("warns safely about bounded revocation failure without replacing the operation result", async () => {
    vi.useFakeTimers();
    const { session, query, warning } = sessionHarness(50);
    await session.start();
    query.mockImplementationOnce(() => new Promise(() => undefined));
    const closing = session.revoke();
    await vi.advanceTimersByTimeAsync(50);
    await expect(closing).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledExactlyOnceWith(REVOKE_WARNING);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for in-progress registration and revokes its committed row on cancellation", async () => {
    const { session, query } = sessionHarness();
    let registered: (rows: Record<string, unknown>[]) => void = () => undefined;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          registered = resolve;
        }),
    );
    const started = session.start();
    const closed = session.revoke();
    registered([metadata()]);
    await Promise.all([started, closed]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("UPDATE cli_sessions");
    await expect(session.token()).rejects.toMatchObject({ fatal: true });
  });
});
