import { appendFileSync } from "node:fs";
import { neonConfig } from "@neondatabase/serverless";

const events = process.env.CLI_PROCESS_EVENTS!;
const mode = process.env.CLI_PROCESS_MODE;
let serial = 0;

function result(query: string) {
  const operation = /^\s*(\w+)/.exec(query)?.[1] ?? "unknown";
  appendFileSync(events, `${operation}\n`);
  const insert = operation === "INSERT";
  const now = new Date();
  const values = insert
    ? {
        id: `10000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 900_000).toISOString(),
        db_now: now.toISOString(),
      }
    : { id: "10000000-0000-4000-8000-000000000001" };
  return {
    fields: Object.keys(values).map((name) => ({ name, dataTypeID: 25 })),
    rows: [Object.values(values)],
    rowCount: 1,
    command: operation,
  };
}

neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
  if (mode === "permission" || mode === "migration") {
    appendFileSync(events, "REFUSED\n");
    return Response.json(
      {
        code: mode === "permission" ? "42501" : "42P01",
        message: process.env.DATABASE_URL,
        detail: process.env.DATABASE_URL,
      },
      { status: 400 },
    );
  }
  const body = JSON.parse(String(init.body)) as
    { query: string } | { queries: Array<{ query: string }> };
  return Response.json(
    "queries" in body
      ? { results: body.queries.map(({ query }) => result(query)) }
      : result(body.query),
  );
};
