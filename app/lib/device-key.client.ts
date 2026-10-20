const DB_NAME = "v-rooms";
const STORE = "device";
const KEY_ID = "identity";
const SIGNING_PREFIX = "v-rooms.device-session.v1:";

export class DeviceKeyUnavailable extends Error {
  constructor(cause?: unknown) {
    super("This browser cannot hold a device key.");
    this.name = "DeviceKeyUnavailable";
    this.cause = cause;
  }
}

export class SignInRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignInRefused";
  }
}

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onblocked = () => {
      abandoned = true;
      reject(new Error("Browser key storage is blocked."));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function validPair(value: unknown): value is CryptoKeyPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as CryptoKeyPair;
  return (
    pair.privateKey instanceof CryptoKey &&
    pair.publicKey instanceof CryptoKey &&
    pair.privateKey.type === "private" &&
    !pair.privateKey.extractable &&
    pair.publicKey.type === "public" &&
    pair.privateKey.algorithm.name === "ECDSA" &&
    pair.publicKey.algorithm.name === "ECDSA" &&
    (pair.privateKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256" &&
    (pair.publicKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256"
  );
}

function readOrCreate(
  db: IDBDatabase,
  candidate: CryptoKeyPair,
): Promise<CryptoKeyPair> {
  return new Promise((resolve, reject) => {
    let selected: CryptoKeyPair | undefined;
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(KEY_ID);
    transaction.oncomplete = () =>
      selected
        ? resolve(selected)
        : reject(new Error("Browser key was not committed."));
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("Browser key transaction was aborted."),
      );
    request.onsuccess = () => {
      try {
        if (request.result === undefined) {
          selected = candidate;
          store.add(candidate, KEY_ID);
        } else if (validPair(request.result)) {
          selected = request.result;
        } else {
          transaction.abort();
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
  });
}

export async function deviceKey(): Promise<CryptoKeyPair> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle)
    throw new DeviceKeyUnavailable();
  try {
    const candidate = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const db = await openStore();
    try {
      return await readOrCreate(db, candidate);
    } finally {
      db.close();
    }
  } catch (error) {
    throw new DeviceKeyUnavailable(error);
  }
}

function toBase64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  } | null;
  if (!response.ok) {
    throw new SignInRefused(
      payload?.error?.code ?? `http_${response.status}`,
      payload?.error?.message ?? "Could not sign in. Try again.",
    );
  }
  return payload?.data ?? {};
}

export async function enterWithDeviceKey(): Promise<void> {
  const pair = await deviceKey();
  const { challenge } = await postJson("/api/device/challenge");
  if (typeof challenge !== "string")
    throw new SignInRefused("bad_challenge", "Could not start sign-in.");

  const [spki, signature] = await Promise.all([
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(SIGNING_PREFIX + challenge),
    ),
  ]);

  await postJson("/api/device/session", {
    publicKey: toBase64url(spki),
    challenge,
    signature: toBase64url(signature),
  });
}
