import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const databaseUrl = "postgresql://synthetic:qa-secret@fixture.invalid/test";
const status = {
  rooms: [],
  aggregate: { online: 0, messages: 0, killed: false },
};
let directory: string;
let origin: string;
let paths: string[];
let children: ChildProcess[];
let handle: (path: string, response: ServerResponse) => void;
const server = createServer((request, response) => {
  const path = request.url!;
  paths.push(path);
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.authorization ?? "")) {
    response.writeHead(401).end();
    return;
  }
  handle(path, response);
});

function send(response: ServerResponse, data: unknown, code = 200) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function run(args: string[], mode = "success") {
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(root, "node_modules/tsx/dist/loader.mjs"),
      "--import",
      join(root, "test/unit/mod-process-preload.ts"),
      join(root, "scripts/mod.ts"),
      ...args,
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: databaseUrl,
        VROOMS_ORIGIN: origin,
        VAUTH_SIGN_IN: "off",
        NO_COLOR: "1",
        CLI_PROCESS_EVENTS: join(directory, "events"),
        CLI_PROCESS_MODE: mode,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  return {
    child,
    done: new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    ),
  };
}

async function events() {
  return readFile(join(directory, "events"), "utf8").catch(() => "");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vroom-cli-process-"));
  await writeFile(
    join(directory, ".env"),
    "DATABASE_URL=invalid-ignored-value\nVROOMS_ORIGIN=https://ignored.invalid\n",
  );
  paths = [];
  children = [];
  handle = (path, response) =>
    send(response, {
      data: path.endsWith("/status") ? status : { ok: true, intent: "restore" },
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("actual moderation CLI process", () => {
  it.each([
    { args: ["--help"], code: 0 },
    { args: ["unknown-command"], code: 1 },
    { args: [], code: 1 },
  ])("exits $args without database or HTTP work", async ({ args, code }) => {
    const result = await run(args).done;
    expect(result.code).toBe(code);
    expect(await events()).toBe("");
    expect(paths).toEqual([]);
  });

  it("honors inherited configuration and completes real loopback HTTP with teardown", async () => {
    const result = await run(["restore", "quiet-ibex"]).done;
    expect(result).toEqual({
      code: 0,
      stdout: '{\n  "ok": true,\n  "intent": "restore"\n}\n',
      stderr: "",
    });
    expect(paths).toEqual(["/api/mod/status", "/api/mod/restore"]);
    expect(await events()).toBe("INSERT\nDELETE\nUPDATE\n");
  });

  it.each(["permission", "migration"])(
    "reports actual Neon driver %s errors safely",
    async (mode) => {
      const result = await run(["status"], mode).done;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        mode === "permission" ? "permission" : "migration is missing",
      );
      expect(result.stderr).not.toContain(databaseUrl);
      expect(result.stderr).not.toContain("qa-secret");
      expect(paths).toEqual([]);
      expect(await events()).toBe("REFUSED\n");
    },
  );

  it("refuses a different Worker database without sending the command", async () => {
    handle = (_path, response) =>
      send(response, { error: { code: "bad_token" } }, 401);
    const result = await run(["restore", "quiet-ibex"]).done;
    expect(result.code).toBe(1);
    expect(paths).toEqual(["/api/mod/status"]);
    expect(await events()).toBe("INSERT\nDELETE\nUPDATE\n");
  });

  it.each(["unauthorized", "disconnect", "redirect"])(
    "does not replay or redirect a mutation after %s",
    async (mode) => {
      handle = (path, response) => {
        if (path.endsWith("/status")) send(response, { data: status });
        else if (mode === "disconnect") response.destroy();
        else if (mode === "redirect")
          response.writeHead(307, { location: `${origin}/unexpected` }).end();
        else send(response, { error: { code: "bad_token" } }, 401);
      };
      const result = await run(["restore", "quiet-ibex"]).done;
      expect(result.code).toBe(1);
      expect(paths).toEqual(["/api/mod/status", "/api/mod/restore"]);
      expect((await events()).trim().split("\n").at(-1)).toBe("UPDATE");
      if (mode === "unauthorized") {
        expect(result.stderr).toContain("not replayed");
        expect(await events()).toContain("SELECT\nINSERT\nUPDATE\n");
      }
    },
  );

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "revokes on an actual %s while HTTP is pending",
    async (signal, code) => {
      let child: ChildProcess;
      handle = () => child.kill(signal);
      const running = run(["restore", "quiet-ibex"]);
      child = running.child;
      const result = await running.done;
      expect(result.code).toBe(code);
      expect(paths).toEqual(["/api/mod/status"]);
      expect(await events()).toBe("INSERT\nDELETE\nUPDATE\n");
    },
  );
});
