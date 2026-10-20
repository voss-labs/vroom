import type { NeonQueryFunction } from "@neondatabase/serverless";
import { vi } from "vitest";
import { ModSession } from "../../scripts/mod-session";

export const databaseUrl =
  "postgresql://operator:private-password@db.example.test/rooms";
export const config = { origin: "https://rooms.example.test", databaseUrl };
export const sessionId = "10000000-0000-4000-8000-000000000001";
export const nextSessionId = "10000000-0000-4000-8000-000000000002";

export function metadata(id = sessionId) {
  return {
    id,
    created_at: "2040-01-01T00:00:00.000Z",
    expires_at: "2040-01-01T00:15:00.000Z",
    db_now: "2040-01-01T00:00:00.000Z",
  };
}

interface Statement {
  text: string;
  params: unknown[];
}

export function sessionHarness(timeoutMs = 100) {
  const clock = { value: 1000 };
  const warning = vi.fn();
  const query = vi.fn(
    async (
      text: string,
      _params?: unknown[],
      _options?: { fetchOptions?: { signal?: AbortSignal } },
    ): Promise<Record<string, unknown>[]> =>
      text.startsWith("INSERT") ? [metadata()] : [],
  );
  const batches: Statement[][] = [];
  const transaction = vi.fn(
    async (
      build: (tx: {
        query: (text: string, params: unknown[]) => Statement;
      }) => unknown[],
    ) => {
      batches.push(
        build({ query: (text, params) => ({ text, params }) }) as Statement[],
      );
      return [[{ id: sessionId }], [metadata(nextSessionId)], []];
    },
  );
  const sql = { query, transaction } as unknown as NeonQueryFunction<
    false,
    false
  >;
  const session = new ModSession(config, {
    sql,
    now: () => clock.value,
    timeoutMs,
    warning,
  });
  return { session, clock, warning, query, transaction, batches, sql };
}
