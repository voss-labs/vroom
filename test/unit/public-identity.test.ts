import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";

import type { MemberRecord } from "~/db/queries/members";

const members = new Map<string, MemberRecord>();
const keys = new Map<string, MemberRecord>();
const getSessionUser = vi.fn();

vi.mock("~/db/queries/members", () => ({
  findMemberById: vi.fn(async (id: string) => members.get(id) ?? null),
  findAnyMemberByKeyHash: vi.fn(async (hash: string) => keys.get(hash) ?? null),
  ensureMemberByKey: vi.fn(async (hash: string) => {
    const existing = keys.get(hash);
    if (existing) return existing;
    const id = `device-${keys.size + 1}`;
    const member: MemberRecord = {
      id,
      userId: null,
      pseudonym: `quiet-ibex${keys.size + 1}`,
      isModerator: false,
      suspendedAt: null,
      suspendedReason: null,
      deletedAt: null,
      createdAt: new Date(),
    };
    members.set(id, member);
    keys.set(hash, member);
    return member;
  }),
  claimPseudonym: vi.fn(),
}));
vi.mock("~/lib/auth.server", () => ({ getSessionUser }));
vi.mock("~/lib/handle-brake.server", () => ({
  allowNewHandle: vi.fn(async () => true),
}));
vi.mock("~/lib/room.server", () => ({
  readRoomPulses: vi.fn(async () => null),
}));

const { DEVICE_COOKIE, SIGNING_PREFIX, mintChallenge, readDeviceSession } =
  await import("~/lib/device-session.server");
const { action: openSession } = await import("~/routes/api.device.session");
const { action: socketToken } = await import("~/routes/api.socket-token");
const { loader: home, headers: homeHeaders } = await import("~/routes/home");
const { resolveActor } = await import("~/lib/require-role.server");
const ORIGIN = "https://vroom.vosslabs.org";

function request(
  path: string,
  cookie = "better-auth.session_token=same-session",
  body?: unknown,
) {
  return new Request(`${ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function newKey() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
}

async function signIn(pair: CryptoKeyPair) {
  const challenge = await mintChallenge();
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(SIGNING_PREFIX + challenge),
  );
  const response = await openSession({
    request: request("/api/device/session", undefined, {
      challenge,
      publicKey: Buffer.from(spki).toString("base64url"),
      signature: Buffer.from(signature).toString("base64url"),
    }),
  } as never);
  expect(response.status).toBe(200);
  return `${response.headers.get("set-cookie")!.split(";")[0]}; better-auth.session_token=same-session`;
}

beforeEach(() => {
  vi.clearAllMocks();
  members.clear();
  keys.clear();
  process.env.DEVICE_SESSION_SECRET = "identity-regression-device-secret";
  process.env.APP_JWT_SECRET = "identity-regression-app-secret";
  getSessionUser.mockResolvedValue({ id: "shared-vauth-user", name: "unused" });
});

describe("student identity boundary", () => {
  it("keeps real key proofs separate and repeated proofs stable despite a shared V Auth session", async () => {
    const a = await newKey();
    const b = await newKey();
    const cookieA = await signIn(a);
    const cookieB = await signIn(b);
    const cookieA2 = await signIn(a);
    const actors = await Promise.all(
      [cookieA, cookieB, cookieA2].map((cookie) =>
        resolveActor(request("/", cookie)),
      ),
    );
    expect(actors.map((actor) => actor?.member.id)).toEqual([
      "device-1",
      "device-2",
      "device-1",
    ]);
    expect(keys.size).toBe(2);
    expect(await readDeviceSession(request("/", cookieA))).toBe("device-1");
    expect(await readDeviceSession(request("/", cookieB))).toBe("device-2");
    expect(getSessionUser).not.toHaveBeenCalled();
  });

  it("mints distinct socket subjects and handles from each device cookie", async () => {
    const cookies = [
      await signIn(await newKey()),
      await signIn(await newKey()),
    ];
    const subjects: Array<string | undefined> = [];
    for (const cookie of cookies) {
      const response = await socketToken({
        request: request("/api/socket-token", cookie, {
          roomId: "campus-live",
        }),
      } as never);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      const { data } = (await response.json()) as {
        data: { token: string; pseudonym: string };
      };
      const claims = decodeJwt(data.token);
      expect(claims.sub).toBe(data.pseudonym);
      subjects.push(claims.sub);
    }
    expect(subjects[0]).not.toBe(subjects[1]);
    expect(getSessionUser).not.toHaveBeenCalled();
  });

  it.each([
    "better-auth.session_token=same-session",
    `${DEVICE_COOKIE}=invalid; better-auth.session_token=same-session`,
  ])(
    "refuses a missing or invalid device cookie without V Auth fallback",
    async (cookie) => {
      expect(await resolveActor(request("/", cookie))).toBeNull();
      const response = await socketToken({
        request: request("/api/socket-token", cookie, {
          roomId: "campus-live",
        }),
      } as never);
      expect(response.status).toBe(401);
      expect(getSessionUser).not.toHaveBeenCalled();
    },
  );

  it("requires device entry on home with V Auth alone, then redirects only the device holder", async () => {
    expect(homeHeaders()).toEqual({ "Cache-Control": "private, no-store" });
    const result = await home({ request: request("/") } as never);
    expect(result).toHaveProperty("data.pulses", null);
    expect(result.init?.headers).toMatchObject({
      "Cache-Control": "private, no-store",
    });
    const cookie = await signIn(await newKey());
    await expect(
      home({ request: request("/", cookie) } as never),
    ).rejects.toMatchObject({ status: 302, headers: expect.any(Headers) });
    expect(getSessionUser).not.toHaveBeenCalled();
  });
});
