import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deviceKey,
  DeviceKeyUnavailable,
  enterWithDeviceKey,
} from "~/lib/device-key.client";

let factory: IDBFactory;

async function publicKey(pair: CryptoKeyPair): Promise<string> {
  return Buffer.from(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  ).toString("base64url");
}

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("persistent anonymous browser key", () => {
  it("retains the same non-extractable identity across calls and module reloads", async () => {
    const first = await deviceKey();
    const second = await deviceKey();
    vi.resetModules();
    const reloaded = await import("~/lib/device-key.client");
    const third = await reloaded.deviceKey();
    expect(await publicKey(first)).toBe(await publicKey(second));
    expect(await publicKey(first)).toBe(await publicKey(third));
    expect(first.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey("pkcs8", first.privateKey),
    ).rejects.toThrow();
  });

  it("keeps isolated browser storage contexts independent", async () => {
    const profileA = await publicKey(await deviceKey());
    vi.stubGlobal("indexedDB", new IDBFactory());
    const profileB = await publicKey(await deviceKey());
    expect(profileA).not.toBe(profileB);
    vi.stubGlobal("indexedDB", factory);
    expect(await publicKey(await deviceKey())).toBe(profileA);
  });

  it("commits one winning identity for simultaneous first-tab entries", async () => {
    const pairs = await Promise.all(
      Array.from({ length: 12 }, () => deviceKey()),
    );
    const publicKeys = await Promise.all(pairs.map(publicKey));
    expect(new Set(publicKeys).size).toBe(1);
    expect(await publicKey(await deviceKey())).toBe(publicKeys[0]);
  });

  it("fails closed when key storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(deviceKey()).rejects.toBeInstanceOf(DeviceKeyUnavailable);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(enterWithDeviceKey()).rejects.toBeInstanceOf(
      DeviceKeyUnavailable,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles storage open failure explicitly", async () => {
    vi.spyOn(factory, "open").mockImplementation(() => {
      throw new DOMException("disabled", "SecurityError");
    });
    await expect(deviceKey()).rejects.toBeInstanceOf(DeviceKeyUnavailable);
  });

  it("rejects a blocked open and closes a late connection", async () => {
    const close = vi.fn();
    const request = {} as IDBOpenDBRequest;
    vi.spyOn(factory, "open").mockImplementation(() => {
      queueMicrotask(() =>
        request.onblocked?.call(
          request,
          new Event("blocked") as IDBVersionChangeEvent,
        ),
      );
      return request;
    });
    await expect(deviceKey()).rejects.toBeInstanceOf(DeviceKeyUnavailable);
    Object.defineProperty(request, "result", { value: { close } });
    request.onsuccess?.call(request, new Event("success"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an aborted transaction and preserves an already committed key", async () => {
    const existing = await publicKey(await deviceKey());
    const transaction = IDBDatabase.prototype.transaction;
    const spy = vi
      .spyOn(IDBDatabase.prototype, "transaction")
      .mockImplementation(function (this: IDBDatabase, ...args) {
        const result = transaction.apply(this, args);
        queueMicrotask(() => result.abort());
        return result;
      });
    await expect(deviceKey()).rejects.toBeInstanceOf(DeviceKeyUnavailable);
    spy.mockRestore();
    expect(await publicKey(await deviceKey())).toBe(existing);
  });

  it("rejects CryptoKey storage failure instead of using an uncommitted key", async () => {
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(() => {
      throw new DOMException("storage full", "QuotaExceededError");
    });
    await expect(deviceKey()).rejects.toBeInstanceOf(DeviceKeyUnavailable);
  });

  it("re-proves the same identity with a fresh challenge after the session is gone", async () => {
    const proofs: Array<{
      publicKey: string;
      challenge: string;
      signature: string;
    }> = [];
    let serial = 0;
    const fetch = vi.fn(async (path: string, init: RequestInit) => {
      expect(init.credentials).toBe("same-origin");
      if (path.endsWith("challenge"))
        return Response.json({ data: { challenge: `fresh-${++serial}` } });
      proofs.push(JSON.parse(init.body as string));
      return Response.json({ data: { ok: true } });
    });
    vi.stubGlobal("fetch", fetch);
    await enterWithDeviceKey();
    await enterWithDeviceKey();
    expect(proofs[0].publicKey).toBe(proofs[1].publicKey);
    expect(proofs[0].challenge).not.toBe(proofs[1].challenge);
    const pair = await deviceKey();
    for (const proof of proofs) {
      expect(
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          pair.publicKey,
          Buffer.from(proof.signature, "base64url"),
          new TextEncoder().encode(
            `v-rooms.device-session.v1:${proof.challenge}`,
          ),
        ),
      ).toBe(true);
    }
  });
});
