import { neon, neonConfig } from "@neondatabase/serverless";
import { prepared, runSql } from "./policy-fixture";

interface Statement {
  query: string;
  params: unknown[];
}

export function localSessionDriver() {
  const previous = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const body: Statement | { queries: Statement[] } = JSON.parse(
      String(init.body),
    );
    const batch = "queries" in body;
    const statements = batch ? body.queries : [body];
    const sql = statements
      .map(({ query, params }) => {
        const statement =
          /\breturning\b/i.test(query) || /^\s*select/i.test(query)
            ? query
            : `${query} RETURNING id`;
        return prepared({
          sql: `WITH result AS (${statement}) SELECT COALESCE(json_agg(row_to_json(result)), '[]') FROM result`,
          params,
        }).replace(
          "EXECUTE materialize_policy();",
          "EXECUTE materialize_policy;",
        );
      })
      .join("\n");
    const rows = (await runSql(`BEGIN; ${sql} COMMIT;`))
      .split("\n")
      .map((row) => JSON.parse(row) as Record<string, string>[]);
    const results = rows.map((items) => {
      const names = Object.keys(items[0] ?? {});
      return {
        fields: names.map((name) => ({ name, dataTypeID: 25 })),
        rows: items.map((item) => names.map((name) => item[name])),
        rowCount: items.length,
        command: "SELECT",
      };
    });
    return Response.json(batch ? { results } : results[0]);
  };
  return {
    sql: neon("postgresql://synthetic:synthetic@cli-fixture.invalid/test"),
    restore: () => {
      neonConfig.fetchFunction = previous;
    },
  };
}
