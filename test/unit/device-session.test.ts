import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { MemberRecord } from "~/db/queries/members";

/**
 * Device-key sign-in (VRIP-13), driven with real P-256 keys from WebCrypto so
 * the signature checks are the ones production runs, not a stand-in.
 */

const ensureMemberByKey = vi.fn();
const findAnyMemberByKeyHash = vi.fn();
const ensureMember = vi.fn();
const findMemberById = vi.fn();
const getSessionUser = vi.fn();
const allowNewHandle = vi.fn();

vi.mock("~/db/queries/members", () => ({
  ensureMemberByKey: (...a: unknown[]) => ensureMemberByKey(...a),
  findAnyMemberByKeyHash: (...a: unknown[]) => findAnyMemberByKeyHash(...a),
  ensureMember: (...a: unknown[]) => ensureMember(...a),
  findMemberById: (...a: unknown[]) => findMemberById(...a),
}));
vi.mock("~/lib/auth.server", () => ({
  getSessionUser: (...a: unknown[]) => getSessionUser(...a),
}));
vi.mock("~/lib/handle-brake.server", () => ({
  allowNewHandle: (...a: unknown[]) => allowNewHandle(...a),
}));

process.env.DEVICE_SESSION_SECRET = "test-device-session-secret";

const {
  DEVICE_COOKIE,
  SIGNING_PREFIX,
  mintChallenge,
  mintDeviceSession,
  readDeviceSession,
  verifyDeviceProof,
} = await import("~/lib/device-session.server");
const { action: openSession } = await import("~/routes/api.device.session");
const { action: challengeRoute } =
  await import("~/routes/api.device.challenge");
const { resolveActor } = await import("~/lib/require-role.server");

const ORIGIN = "https://vroom.vosslabs.org";

function b64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

async function keyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
}

async function prove(
  pair: CryptoKeyPair,
  challenge: string,
  prefix = SIGNING_PREFIX,
) {
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(prefix + challenge),
  );
  return { publicKey: b64url(spki), challenge, signature: b64url(signature) };
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "m1",
    userId: null,
    pseudonym: "quiet-ibex",
    isModerator: false,
    suspendedAt: null,
    suspendedReason: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue(null);
  findAnyMemberByKeyHash.mockResolvedValue(null);
  allowNewHandle.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyDeviceProof", () => {
  it("accepts a fresh challenge signed by the presented key", async () => {
    const pair = await keyPair();
    const result = await verifyDeviceProof(
      await prove(pair, await mintChallenge()),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same key the same hash every time, and another key another", async () => {
    const a = await keyPair();
    const b = await keyPair();
    const [a1, a2, b1] = await Promise.all([
      verifyDeviceProof(await prove(a, await mintChallenge())),
      verifyDeviceProof(await prove(a, await mintChallenge())),
      verifyDeviceProof(await prove(b, await mintChallenge())),
    ]);
    if (!a1.ok || !a2.ok || !b1.ok) throw new Error("expected valid proofs");
    expect(a1.keyHash).toBe(a2.keyHash);
    expect(a1.keyHash).not.toBe(b1.keyHash);
  });

  it("refuses a signature made by a different key", async () => {
    const challenge = await mintChallenge();
    const honest = await prove(await keyPair(), challenge);
    const forged = await prove(await keyPair(), challenge);
    const result = await verifyDeviceProof({
      ...honest,
      signature: forged.signature,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature without the domain prefix", async () => {
    const result = await verifyDeviceProof(
      await prove(await keyPair(), await mintChallenge(), ""),
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an expired challenge", async () => {
    const challenge = await mintChallenge();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    const result = await verifyDeviceProof(
      await prove(await keyPair(), challenge),
    );
    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
  });

  it("refuses a session cookie offered as a challenge", async () => {
    const session = await mintDeviceSession("m1");
    const result = await verifyDeviceProof(
      await prove(await keyPair(), session),
    );
    expect(result).toEqual({ ok: false, reason: "bad_challenge" });
  });

  it("refuses a malformed key and a malformed signature", async () => {
    const proof = await prove(await keyPair(), await mintChallenge());
    expect(
      await verifyDeviceProof({ ...proof, publicKey: "not-a-key" }),
    ).toEqual({ ok: false, reason: "bad_key" });
    expect(await verifyDeviceProof({ ...proof, publicKey: 42 })).toEqual({
      ok: false,
      reason: "bad_key",
    });
    expect(await verifyDeviceProof({ ...proof, signature: "AAAA" })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("device session cookie", () => {
  it("round-trips the member id", async () => {
    const token = await mintDeviceSession("m1");
    const request = new Request(ORIGIN, {
      headers: { cookie: `other=1; ${DEVICE_COOKIE}=${token}` },
    });
    expect(await readDeviceSession(request)).toBe("m1");
  });

  it("refuses a tampered cookie and a challenge passed off as one", async () => {
    const token = await mintDeviceSession("m1");
    const tampered = `${token.slice(0, -2)}xx`;
    for (const value of [tampered, await mintChallenge()]) {
      const request = new Request(ORIGIN, {
        headers: { cookie: `${DEVICE_COOKIE}=${value}` },
      });
      expect(await readDeviceSession(request)).toBeNull();
    }
  });
});

describe("POST /api/device/session", () => {
  it("opens an HttpOnly session for a valid proof", async () => {
    ensureMemberByKey.mockResolvedValue(member());
    const body = await prove(await keyPair(), await mintChallenge());
    const response = await openSession({
      request: post("/api/device/session", body),
    } as never);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${DEVICE_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(ensureMemberByKey).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  it("refuses a bad proof before touching the database", async () => {
    const body = await prove(await keyPair(), await mintChallenge(), "");
    const response = await openSession({
      request: post("/api/device/session", body),
    } as never);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(ensureMemberByKey).not.toHaveBeenCalled();
  });

  it("refuses a suspended handle and sets no cookie", async () => {
    ensureMemberByKey.mockResolvedValue(member({ suspendedAt: new Date() }));
    const body = await prove(await keyPair(), await mintChallenge());
    const response = await openSession({
      request: post("/api/device/session", body),
    } as never);
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a new handle over the edge brake, before any insert", async () => {
    allowNewHandle.mockResolvedValue(false);
    const body = await prove(await keyPair(), await mintChallenge());
    const response = await openSession({
      request: post("/api/device/session", body),
    } as never);
    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(ensureMemberByKey).not.toHaveBeenCalled();
  });

  it("lets a returning key in without charging the brake", async () => {
    // A campus behind one NAT address must spend the budget on newcomers only.
    findAnyMemberByKeyHash.mockResolvedValue(member());
    allowNewHandle.mockResolvedValue(false);
    const body = await prove(await keyPair(), await mintChallenge());
    const response = await openSession({
      request: post("/api/device/session", body),
    } as never);
    expect(response.status).toBe(200);
    expect(allowNewHandle).not.toHaveBeenCalled();
    expect(ensureMemberByKey).not.toHaveBeenCalled();
  });

  it("answers 503 rather than 500 when the database is down", async () => {
    ensureMemberByKey.mockRejectedValue(new Error("neon unreachable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await prove(await keyPair(), await mintChallenge());
    const response = await openSession({
      request: post("/api/device/session", body),
    } as never);
    expect(response.status).toBe(503);
  });

  it("refuses a cross-site request, for both endpoints", async () => {
    const cross = { "sec-fetch-site": "cross-site" };
    const session = await openSession({
      request: post("/api/device/session", {}, cross),
    } as never);
    const challenge = await challengeRoute({
      request: post("/api/device/challenge", {}, cross),
    } as never);
    expect(session.status).toBe(403);
    expect(challenge.status).toBe(403);
  });
});

describe("resolveActor", () => {
  function withCookie(token: string) {
    return new Request(ORIGIN, {
      headers: { cookie: `${DEVICE_COOKIE}=${token}` },
    });
  }

  it("resolves a student from the device cookie", async () => {
    findMemberById.mockResolvedValue(member());
    const actor = await resolveActor(withCookie(await mintDeviceSession("m1")));
    expect(actor).toMatchObject({ kind: "device", member: { id: "m1" } });
  });

  it("refuses a device cookie that points at a V Auth account", async () => {
    findMemberById.mockResolvedValue(member({ userId: "u1" }));
    const actor = await resolveActor(withCookie(await mintDeviceSession("m1")));
    expect(actor).toBeNull();
  });

  it("keeps a device actor when the browser also has a V Auth session", async () => {
    getSessionUser.mockResolvedValue({ id: "u1", name: "Mod" });
    findMemberById.mockResolvedValue(member());
    const actor = await resolveActor(withCookie(await mintDeviceSession("m1")));
    expect(actor).toMatchObject({ kind: "device", member: { id: "m1" } });
    expect(getSessionUser).not.toHaveBeenCalled();
    expect(ensureMember).not.toHaveBeenCalled();
  });
});
