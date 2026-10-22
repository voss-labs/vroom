import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliError,
  createModClient,
  readConfig,
  safeError,
} from "../../scripts/mod-client";

const token = "a".repeat(43);
const databaseUrl = "postgresql://operator:test-password@db.example.test/rooms";
const config = { origin: "https://rooms.example.test", token };

afterEach(() => vi.useRealTimers());

describe("moderation client configuration", () => {
  it.each([
    "https://rooms.example.test",
    "https://rooms.example.test/",
    "http://localhost:5173",
    "http://127.0.0.1:5173/",
    "http://[::1]:5173",
  ])("accepts a root HTTPS or loopback origin: %s", (origin) => {
    expect(
      readConfig({ VROOMS_ORIGIN: origin, DATABASE_URL: databaseUrl }),
    ).toEqual({
      origin: new URL(origin).origin,
      databaseUrl,
    });
  });

  it.each([
    "http://rooms.example.test",
    "http://localhost.example.test",
    "https://operator:secret@rooms.example.test",
    "https://@rooms.example.test",
    "https://rooms.example.test/path",
    "https://rooms.example.test/path/..",
    "https://rooms.example.test/?credential=secret",
    "https://rooms.example.test?",
    "https://rooms.example.test/#secret",
    "https://rooms.example.test#",
    "https://rooms.example.test\\path",
    "https://rooms.example.test\n",
    "file:///private/tmp",
    "not a URL",
  ])("rejects unsafe configuration without echoing it: %s", (origin) => {
    let error: unknown;
    try {
      readConfig({ VROOMS_ORIGIN: origin, DATABASE_URL: databaseUrl });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(safeError(error)).not.toContain(origin);
    expect(safeError(error)).not.toContain(token);
  });

  it("requires database credentials and rejects malformed URLs", () => {
    expect(() => readConfig({})).toThrow("VROOMS_ORIGIN is not set");
    expect(() => readConfig({ VROOMS_ORIGIN: config.origin })).toThrow(
      "DATABASE_URL is not set",
    );
    expect(() =>
      readConfig({
        VROOMS_ORIGIN: config.origin,
        DATABASE_URL: "not a database URL",
      }),
    ).toThrow("invalid format");
  });
});

describe("moderation transport", () => {
  it.each([
    [
      "report_target_unavailable",
      "This report has no current author account to suspend. Refresh the reports.",
    ],
    [
      "report_target_mismatch",
      "The selected account does not match this report. Refresh the reports.",
    ],
  ])(
    "explains %s without printing server text or credentials",
    async (code, message) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: { code, message: `${config.origin}?token=${token}` } },
            { status: 409 },
          ),
        );

      const error = await createModClient(config, fetcher)("suspend", {
        handle: "calm-fox",
        reportId: "report-1",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CliError);
      expect(safeError(error)).toBe(message);
      expect(safeError(error)).not.toContain(config.origin);
      expect(safeError(error)).not.toContain(token);
    },
  );

  it("posts only the validated endpoint with bearer header and redirect rejection", async () => {
    const data = { intent: "restore", ok: true };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data }));
    await expect(
      createModClient(config, fetcher)("restore", { handle: "quiet-ibex" }),
    ).resolves.toEqual(data);
    const [url, request] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://rooms.example.test/api/mod/restore");
    expect(String(url)).not.toContain(token);
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      body: JSON.stringify({ handle: "quiet-ibex" }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([302, 307, 308])("refuses HTTP %s redirects", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status,
        headers: { location: "https://elsewhere.example.test" },
      }),
    );
    await expect(createModClient(config, fetcher)("status")).rejects.toThrow(
      "No redirect was followed",
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not print raw errors, URLs, tokens or server error text", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${config.origin}?token=${token}`));
    const error = await createModClient(
      config,
      fetcher,
    )("status").catch((caught: unknown) => caught);
    expect(safeError(error)).toContain("could not be completed");
    expect(safeError(error)).not.toContain(token);
    expect(safeError(error)).not.toContain(config.origin);
    fetcher.mockResolvedValue(
      Response.json(
        { error: { code: "bad_token", message: token } },
        { status: 401 },
      ),
    );
    const denied = await createModClient(
      config,
      fetcher,
    )("reports").catch((caught: unknown) => caught);
    expect(safeError(denied)).toContain("Authentication failed");
    expect(safeError(denied)).not.toContain(token);
    fetcher.mockResolvedValue(
      Response.json(
        { error: { code: token, message: config.origin } },
        { status: 500 },
      ),
    );
    const unknown = await createModClient(
      config,
      fetcher,
    )("status").catch((caught: unknown) => caught);
    expect(safeError(unknown)).toBe("Moderation request failed (HTTP 500).");
    expect(safeError(new Error(token))).not.toContain(token);
  });

  it("aborts a timed out mutation and describes its outcome as unknown", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(token)),
            { once: true },
          );
        }),
    );
    const result = createModClient(
      config,
      fetcher,
      50,
    )("suspend", { handle: "quiet-ibex" }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(50);
    expect(safeError(await result)).toContain("timed out");
    expect(safeError(await result)).toContain("outcome is unknown");
    expect(safeError(await result)).not.toContain(token);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["invalid JSON", "{}", '{"data":null}', '{"data":[]}'])(
    "rejects invalid success envelopes: %s",
    async (body) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body));
      await expect(createModClient(config, fetcher)("status")).rejects.toThrow(
        "invalid response",
      );
    },
  );

  it("retains all room outcomes on partial enforcement failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "room_unreachable",
            message: token,
            partial: true,
            rooms: [
              { roomId: "campus-live", reachable: true },
              { roomId: "after-hours", reachable: false },
              { roomId: token, reachable: false },
              { roomId: "https://secret.example.test", reachable: false },
            ],
          },
        },
        { status: 503 },
      ),
    );
    const error = await createModClient(config, fetcher)("set_room_state", {
      killed: true,
    }).catch((caught: unknown) => caught);
    expect(safeError(error)).toContain("No rollback was performed");
    expect(safeError(error)).toContain(
      "campus-live: reachable; enforcement succeeded",
    );
    expect(safeError(error)).toContain(
      "after-hours: unreachable; enforcement unconfirmed",
    );
    expect(safeError(error)).not.toContain("secret.example.test");
    expect(safeError(error)).not.toContain(token);
  });
});
