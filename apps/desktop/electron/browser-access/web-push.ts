import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm per RFC 8188) and VAPID
 * application server identification (RFC 8292), using only Node's crypto.
 */

export interface PushSubscriptionKeys {
  /** The browser's P-256 public key, uncompressed, base64url. */
  readonly p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  readonly auth: string;
}

export interface StoredPushSubscription {
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url: what browsers pass as applicationServerKey. */
  readonly publicKey: string;
  /** The private scalar, base64url. */
  readonly privateKey: string;
}

const RECORD_SIZE = 4096;

export function base64UrlEncode(data: Buffer): string {
  return data.toString("base64url");
}

export function base64UrlDecode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ""), "base64url");
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("Could not export the VAPID key.");
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    base64UrlDecode(jwk.x),
    base64UrlDecode(jwk.y),
  ]);
  return { publicKey: base64UrlEncode(publicKey), privateKey: jwk.d };
}

function vapidSigningKey(keys: VapidKeys): KeyObject {
  const publicKey = base64UrlDecode(keys.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("The VAPID public key must be an uncompressed P-256 point.");
  }
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: base64UrlEncode(publicKey.subarray(1, 33)),
      y: base64UrlEncode(publicKey.subarray(33, 65)),
    },
  });
}

/** The `Authorization` header value for one push service origin. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: number = Date.now(),
): string {
  const audience = new URL(endpoint).origin;
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: vapidSigningKey(keys),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

export interface EncryptOptions {
  /** For tests only: a fixed salt and sender key make the output deterministic. */
  readonly salt?: Buffer;
  readonly senderPrivateKey?: Buffer;
}

/** Encrypts one push message body for a subscription (a single aes128gcm record). */
export function encryptPushPayload(
  keys: PushSubscriptionKeys,
  plaintext: Buffer,
  options: EncryptOptions = {},
): Buffer {
  const receiverPublic = base64UrlDecode(keys.p256dh);
  const authSecret = base64UrlDecode(keys.auth);
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 0x04) {
    throw new Error("The subscription's p256dh key is not an uncompressed P-256 point.");
  }
  if (authSecret.length !== 16) throw new Error("The subscription's auth secret is not 16 bytes.");
  if (plaintext.length > RECORD_SIZE - 86 - 17) throw new Error("The push message is too long.");

  const sender = createECDH("prime256v1");
  if (options.senderPrivateKey) sender.setPrivateKey(options.senderPrivateKey);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(receiverPublic);
  const salt = options.salt ?? randomBytes(16);

  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    receiverPublic,
    senderPublic,
    Buffer.from([0x01]),
  ]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([senderPublic.length]),
    senderPublic,
    ciphertext,
  ]);
}

export type PushSendResult = "delivered" | "expired" | "failed";

export interface SendPushOptions {
  readonly subscription: StoredPushSubscription;
  readonly payload: unknown;
  readonly vapid: VapidKeys;
  readonly subject: string;
  readonly ttlSeconds?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Sends one push message. `expired` means the browser dropped the subscription. */
export async function sendPush(options: SendPushOptions): Promise<PushSendResult> {
  const body = encryptPushPayload(
    options.subscription.keys,
    Buffer.from(JSON.stringify(options.payload)),
  );
  const response = await (options.fetchImpl ?? fetch)(options.subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(
        options.subscription.endpoint,
        options.vapid,
        options.subject,
      ),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttlSeconds ?? 4 * 60 * 60),
      Urgency: "high",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404 || response.status === 410) return "expired";
  if (response.ok) return "delivered";
  console.warn(`[browser-access] push service answered ${response.status}`);
  return "failed";
}

/**
 * Push services must use HTTPS. Plain HTTP is accepted only on loopback, which a local test
 * push service uses.
 */
export function isAcceptablePushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function isPushSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return (
    typeof candidate.endpoint === "string" &&
    candidate.endpoint.length <= 2048 &&
    isAcceptablePushEndpoint(candidate.endpoint) &&
    typeof candidate.keys?.p256dh === "string" &&
    base64UrlDecode(candidate.keys.p256dh).length === 65 &&
    typeof candidate.keys.auth === "string" &&
    base64UrlDecode(candidate.keys.auth).length === 16
  );
}
