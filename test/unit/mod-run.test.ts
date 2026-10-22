import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModClient, safeError } from "../../scripts/mod-client";
import { runCli } from "../../scripts/mod-run";
import { prompts } from "./mod-test-helpers";
import { config, databaseUrl, sessionHarness } from "./mod-session-helpers";

const env = {
  DATABASE_URL: databaseUrl,
  VROOMS_ORIGIN: config.origin,
  VAUTH_SIGN_IN: "false",
};
const status = {
  rooms: [],
  aggregate: { online: 0, messages: 0, killed: false },
};

afterEach(() => vi.useRealTimers());

describe("database-authorized CLI lifecycle", () => {
  it.each([
    { args: ["--help"], tty: true, expected: 0 },
    { args: ["unknown-command"], tty: true, expected: 1 },
    { args: ["restore", "not a handle"], tty: true, expected: 1 },
    { args: [], tty: false, expected: 1 },
  ])(
    "does no database or HTTP work for $args with tty=$tty",
    async ({ args, tty, expected }) => {
      const session = vi.fn();
      const request = vi.fn<typeof fetch>();
      expect(
        await runCli(args, {
          tty,
          env,
          session,
          request,
          output: vi.fn(),
          warning: vi.fn(),
        }),
      ).toBe(expected);
      expect(session).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("requires DATABASE_URL rather than legacy credentials or V Auth", async () => {
    const session = vi.fn();
    const warning = vi.fn();
    expect(
      await runCli(["status"], {
        env: {
          VROOMS_ORIGIN: config.origin,
          MOD_SCRIPT_TOKEN: "old-secret",
          MOD_SCRIPT_MEMBER_HANDLE: "quiet-ibex",
        },
        session,
        warning,
      }),
    ).toBe(1);
    expect(warning).toHaveBeenCalledExactlyOnceWith("DATABASE_URL is not set.");
    expect(session).not.toHaveBeenCalled();
  });

  it("registers, proves the Worker session with status, executes and revokes without member bootstrap", async () => {
    const { session, query, transaction } = sessionHarness();
    const output = vi.fn();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        expect(query.mock.calls[0][0]).toContain("INSERT INTO cli_sessions");
        expect(String(url)).not.toContain(databaseUrl);
        expect(init?.headers).not.toHaveProperty("cookie");
        return Response.json({
          data: String(url).endsWith("status")
            ? status
            : { ok: true, intent: "restore" },
        });
      });
    expect(
      await runCli(["restore", "quiet-ibex"], {
        env,
        output,
        request,
        session: () => session,
      }),
    ).toBe(0);
    expect(
      request.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/api/mod/status", "/api/mod/restore"]);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      ok: true,
      intent: "restore",
    });
    expect(query.mock.calls.at(-1)?.[0]).toContain("UPDATE cli_sessions");
    expect(transaction).not.toHaveBeenCalled();
    expect(
      query.mock.calls.every(([text]) => !/members|better_auth/.test(text)),
    ).toBe(true);
  });

  it("fails closed against another Worker database or origin and revokes without any operation or refresh", async () => {
    const { session, query, transaction } = sessionHarness();
    const output = vi.fn();
    const warning = vi.fn();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { code: "bad_token", message: databaseUrl } },
          { status: 401 },
        ),
      );
    expect(
      await runCli(["restore", "quiet-ibex"], {
        env,
        output,
        warning,
        request,
        session: () => session,
      }),
    ).toBe(1);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toContain("/api/mod/status");
    expect(output).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)?.[0]).toContain("UPDATE cli_sessions");
    expect(warning.mock.calls.flat().join()).not.toContain(databaseUrl);
  });

  it("renews after a long confirmation before sending the confirmed mutation", async () => {
    const { session, clock, transaction } = sessionHarness();
    const ui = prompts(["open", "exit"], [true]);
    ui.confirm.mockImplementationOnce(async () => {
      clock.value += 900_001;
      return true;
    });
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      Response.json({
        data: String(url).endsWith("status")
          ? status
          : { intent: "set_room_state", ok: true },
      }),
    );
    expect(
      await runCli([], { env, tty: true, ui, request, session: () => session }),
    ).toBe(0);
    const headers = request.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).authorization,
    );
    expect(headers[0]).not.toBe(headers[1]);
    expect(transaction).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ends a revoked idle menu instead of issuing an HTTP mutation", async () => {
    const { session, clock, transaction } = sessionHarness();
    transaction.mockResolvedValueOnce([[], [], []]);
    const ui = prompts(["open"], [true]);
    ui.confirm.mockImplementationOnce(async () => {
      clock.value += 900_001;
      return true;
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: status }));
    const warning = vi.fn();
    expect(
      await runCli([], {
        env,
        tty: true,
        ui,
        request,
        warning,
        session: () => session,
      }),
    ).toBe(1);
    expect(request).toHaveBeenCalledOnce();
    expect(ui.success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("revoked or removed"),
    );
  });

  it("does not replay a mutation rejected at server admission even after renewing the session", async () => {
    const { session, transaction } = sessionHarness();
    const warning = vi.fn();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: status }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "bad_token", message: databaseUrl } },
          { status: 401 },
        ),
      );
    expect(
      await runCli(["restore", "quiet-ibex"], {
        env,
        request,
        warning,
        session: () => session,
      }),
    ).toBe(1);
    expect(transaction).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("action was not replayed"),
    );
  });

  it.each(["disconnect", "partial"])(
    "never replays a mutation after %s",
    async (failure) => {
      const { session, transaction } = sessionHarness();
      const warning = vi.fn();
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ data: status }));
      if (failure === "disconnect")
        request.mockRejectedValueOnce(new Error(databaseUrl));
      else
        request.mockResolvedValueOnce(
          Response.json(
            {
              error: {
                code: "room_unreachable",
                partial: true,
                rooms: [{ roomId: "campus-live", reachable: true }],
              },
            },
            { status: 503 },
          ),
        );
      expect(
        await runCli(["restore", "quiet-ibex"], {
          env,
          request,
          warning,
          session: () => session,
        }),
      ).toBe(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(transaction).not.toHaveBeenCalled();
      expect(warning.mock.calls.flat().join()).not.toContain(databaseUrl);
    },
  );

  it("redacts database URLs and all session tokens from successful output as defense in depth", async () => {
    const { session } = sessionHarness();
    const output = vi.fn();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) =>
        Response.json({
          data: {
            databaseUrl,
            token: (
              init?.headers as Record<string, string>
            ).authorization.slice(7),
          },
        }),
      );
    expect(
      await runCli(["audit"], { env, request, output, session: () => session }),
    ).toBe(0);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      databaseUrl: "[redacted]",
      token: "[redacted]",
    });
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("revokes and exits an idle menu on %s", async (signal, code) => {
    const { session, query } = sessionHarness();
    const signals = new EventEmitter();
    const signalExit = vi.fn();
    const ui = prompts([]);
    ui.select.mockImplementationOnce(() => {
      signals.emit(signal);
      return new Promise(() => undefined);
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: status }));
    expect(
      await runCli([], {
        env,
        tty: true,
        ui,
        request,
        signals,
        signalExit,
        session: () => session,
      }),
    ).toBe(code);
    expect(query.mock.calls.at(-1)?.[0]).toContain("UPDATE cli_sessions");
    expect(signalExit).toHaveBeenCalledExactlyOnceWith(code);
    expect(signals.listenerCount(signal)).toBe(0);
    expect(session.signal.aborted).toBe(true);
  });

  it("revokes after normal prompt cancellation", async () => {
    const { session, query } = sessionHarness();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: status }));
    expect(
      await runCli([], {
        env,
        tty: true,
        ui: prompts([Symbol("cancel")]),
        request,
        session: () => session,
      }),
    ).toBe(0);
    expect(query.mock.calls.at(-1)?.[0]).toContain("UPDATE cli_sessions");
  });
});

describe("bounded moderation HTTP", () => {
  it.each(["fetch", "body"])(
    "bounds a hung %s even if the server ignores cancellation without replaying",
    async (stage) => {
      vi.useFakeTimers();
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (stage === "fetch") return new Promise(() => undefined);
        const response = Response.json({ data: {} });
        response.json = () => new Promise(() => undefined);
        return response;
      });
      const result = createModClient(
        { origin: config.origin, token: "x".repeat(43) },
        request,
        50,
      )("restore", { handle: "quiet-ibex" }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(safeError(await result)).toContain("outcome is unknown");
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
