import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Query } from "drizzle-orm";
import * as tables from "~/db/schema";
import { prepared, runSql, schema } from "./policy-fixture";
import {
  authorId,
  deletedId,
  reportFixtureSql,
  reportId,
  reporterId,
  resolverId,
  unknownId,
} from "./report-fixture";

const queries: Query[] = [];
vi.mock("~/db", async () => ({
  db: drizzle(
    async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    { schema: tables },
  ),
}));

const { createReport, listReports, findReport } =
  await import("~/db/queries/reports");
const migration = readFileSync(
  new URL(
    "../../app/db/migrations/0004_retained_report_author.sql",
    import.meta.url,
  ),
  "utf8",
);
const otherSchema = `${schema}_other`;
let created = false;
let createdOther = false;

function captured(): Query {
  return queries[queries.length - 1];
}

async function accountless(
  messageId = "legacy-message",
  authorHandle = "Local Dev",
) {
  await createReport({
    roomId: "hostel",
    messageId,
    reportedMemberId: null,
    reporterMemberId: reporterId,
    authorHandle,
    messageSnapshot: "legacy body",
  });
  return runSql(prepared(captured()));
}

beforeAll(async () => {
  await runSql(`CREATE SCHEMA "${schema}";`, { scope: false });
  created = true;
});

beforeEach(async () => {
  queries.length = 0;
  await runSql(reportFixtureSql);
});

afterAll(async () => {
  if (createdOther)
    await runSql(`DROP SCHEMA "${otherSchema}" CASCADE;`, { scope: false });
  if (created)
    await runSql(`DROP SCHEMA "${schema}" CASCADE;`, { scope: false });
});

describe("retained report migration", () => {
  it.each([
    "reports_reported_member_id_members_id_fk",
    "reports_reported_member_id_fkey",
    "custom_target_link",
  ])("replaces all target FKs when the existing name is %s", async (name) => {
    if (name !== "reports_reported_member_id_members_id_fk") {
      await runSql(
        `ALTER TABLE reports RENAME CONSTRAINT reports_reported_member_id_members_id_fk TO ${name};`,
      );
    }
    await runSql(
      "ALTER TABLE reports ADD CONSTRAINT leftover_target_link FOREIGN KEY (reported_member_id) REFERENCES members(id) ON DELETE CASCADE;",
    );
    const indexesBefore = await runSql(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'reports' ORDER BY indexname;",
    );
    await runSql(migration);
    const foreignKeys = JSON.parse(
      await runSql(`SELECT json_agg(row_to_json(fk)) FROM (
        SELECT a.attname AS column, c.confdeltype AS deletion
        FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'reports'::regclass AND c.contype = 'f' ORDER BY a.attname
      ) fk;`),
    );
    expect(foreignKeys).toEqual([
      { column: "reported_member_id", deletion: "n" },
      { column: "reporter_member_id", deletion: "c" },
      { column: "resolved_by", deletion: "n" },
    ]);
    expect(
      await runSql(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'reports' ORDER BY indexname;",
      ),
    ).toBe(indexesBefore);
    const labels = JSON.parse(
      await runSql(
        "SELECT json_agg(row_to_json(r)) FROM (SELECT message_id, author_handle FROM reports ORDER BY message_id) r;",
      ),
    );
    expect(labels).toEqual([
      { message_id: "deleted-message", author_handle: "quiet-ibex" },
      { message_id: "linked-message", author_handle: "grumpy-heron" },
      { message_id: "unknown-message", author_handle: null },
    ]);
    await runSql(`DELETE FROM members WHERE id = '${authorId}';`);
    const retained = JSON.parse(
      await runSql(`SELECT json_build_object('target', reported_member_id, 'author', author_handle,
        'snapshot', message_snapshot, 'reporter', reporter_member_id, 'resolver', resolved_by) FROM reports WHERE id = '${reportId}';`),
    );
    expect(retained).toEqual({
      target: null,
      author: "grumpy-heron",
      snapshot: "retained body",
      reporter: reporterId,
      resolver: resolverId,
    });
  });

  it("requires a nonblank label for a null target while keeping real links enforced", async () => {
    await runSql(migration);
    for (const author of ["NULL", "''", "'   '", "E'\\t\\n'"]) {
      await expect(
        runSql(
          `INSERT INTO reports(message_id, message_snapshot, author_handle) VALUES ('invalid', 'text', ${author});`,
        ),
      ).rejects.toThrow("reports_retained_author");
    }
    await expect(
      runSql(
        "INSERT INTO reports(message_id, message_snapshot, author_handle, reported_member_id) VALUES ('fake-link', 'text', 'Local Dev', '00000000-0000-0000-0000-000000000999');",
      ),
    ).rejects.toThrow("foreign key constraint");
    await runSql(
      `INSERT INTO reports(message_id, message_snapshot, reported_member_id) VALUES ('old-writer', 'text', '${unknownId}');`,
    );
    expect(
      await runSql(
        "SELECT count(*) FROM reports WHERE message_id = 'old-writer' AND author_handle IS NULL;",
      ),
    ).toBe("1");
  });

  it("writes accountless evidence through the actual report query and deduplicates it", async () => {
    await runSql(migration);
    expect(await accountless()).toMatch(/^[a-f0-9-]{36}$/);
    expect(await accountless()).toBe("");
    expect(await runSql("SELECT count(*) FROM members;")).toBe("5");
    const stored = JSON.parse(
      await runSql(
        "SELECT json_build_object('target', reported_member_id, 'author', author_handle, 'snapshot', message_snapshot) FROM reports WHERE message_id = 'legacy-message';",
      ),
    );
    expect(stored).toEqual({
      target: null,
      author: "Local Dev",
      snapshot: "legacy body",
    });
  });

  it("uses retained display labels and only current linked suspension handles in real reads", async () => {
    await runSql(migration);
    await accountless();
    await runSql(
      `UPDATE members SET pseudonym = 'bright-otter' WHERE id = '${authorId}';`,
    );
    await listReports();
    const rows = (await runSql(prepared(captured())))
      .split("\n")
      .map((row) => row.split("|"));
    expect(
      rows.find((row) => row[1] === "legacy-message")?.slice(4, 7),
    ).toEqual(["Local Dev", "", ""]);
    expect(
      rows.find((row) => row[1] === "linked-message")?.slice(4, 7),
    ).toEqual(["grumpy-heron", "bright-otter", authorId]);
    expect(
      rows.find((row) => row[1] === "deleted-message")?.slice(4, 7),
    ).toEqual(["quiet-ibex", "", deletedId]);
    await runSql(`DELETE FROM members WHERE id = '${authorId}';`);
    await findReport(reportId);
    expect((await runSql(prepared(captured()))).split("|").slice(4, 7)).toEqual(
      ["grumpy-heron", "", ""],
    );
  });

  it("keeps immutable snapshots and safe FK state when rerun", async () => {
    await runSql(migration);
    await runSql(
      `UPDATE members SET pseudonym = 'bright-otter' WHERE id = '${authorId}';`,
    );
    await runSql(migration);
    expect(
      await runSql(
        `SELECT author_handle FROM reports WHERE id = '${reportId}';`,
      ),
    ).toBe("grumpy-heron");
    expect(
      await runSql(
        "SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid = 'reports'::regclass AND contype = 'f' AND confdeltype = 'n';",
      ),
    ).toBe("2");
  });

  it("scopes catalog FK replacement to the selected schema", async () => {
    await runSql(`CREATE SCHEMA "${otherSchema}";`, { scope: false });
    createdOther = true;
    await runSql(
      `CREATE TABLE "${otherSchema}".members (id uuid PRIMARY KEY);
      CREATE TABLE "${otherSchema}".reports (reported_member_id uuid,
        CONSTRAINT reports_reported_member_id_members_id_fk FOREIGN KEY (reported_member_id) REFERENCES "${otherSchema}".members(id) ON DELETE CASCADE);`,
      { scope: false },
    );
    await runSql(migration);
    expect(
      await runSql(
        `SELECT confdeltype FROM pg_catalog.pg_constraint WHERE conrelid = '"${otherSchema}".reports'::regclass AND contype = 'f';`,
      ),
    ).toBe("c");
  });
});
