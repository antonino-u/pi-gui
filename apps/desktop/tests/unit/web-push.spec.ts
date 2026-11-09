import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
  generateVapidKeys,
  isAcceptablePushEndpoint,
  isPushSubscription,
  vapidAuthorization,
} from "../../electron/browser-access/web-push";

// RFC 8291, section 5 and appendix A.
const RFC_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const RFC_RECEIVER_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const RFC_RECEIVER_PUBLIC =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const RFC_SENDER_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const RFC_SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const RFC_BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
const RFC_PLAINTEXT = "When I grow up, I want to be a watermelon";

/** What a browser does with a push body: RFC 8291 decryption with its private key. */
function decrypt(body: Buffer, receiverPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const receiver = createECDH("prime256v1");
  receiver.setPrivateKey(receiverPrivate);
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  const prkKey = hmac(auth, receiver.computeSecret(senderPublic));
  const ikm = hmac(
    prkKey,
    Buffer.concat([
      Buffer.from("WebPush: info\0"),
      receiver.getPublicKey(),
      senderPublic,
      Buffer.from([1]),
    ]),
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  expect(padded[padded.length - 1]).toBe(0x02);
  return padded.subarray(0, padded.length - 1).toString("utf8");
}

test("push encryption matches the RFC 8291 example byte for byte", () => {
  const body = encryptPushPayload(
    { p256dh: RFC_RECEIVER_PUBLIC, auth: RFC_AUTH },
    Buffer.from(RFC_PLAINTEXT),
    { salt: base64UrlDecode(RFC_SALT), senderPrivateKey: base64UrlDecode(RFC_SENDER_PRIVATE) },
  );
  expect(base64UrlEncode(body)).toBe(RFC_BODY);
});

test("a browser can decrypt a push encrypted with a fresh key and salt", () => {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  const message = JSON.stringify({ title: "Thread", body: "Agent finished responding" });
  const body = encryptPushPayload(
    { p256dh: base64UrlEncode(receiver.getPublicKey()), auth: base64UrlEncode(auth) },
    Buffer.from(message),
  );
  expect(decrypt(body, receiver.getPrivateKey(), auth)).toBe(message);
});

test("the VAPID header carries a valid ES256 token for the push service origin", () => {
  const keys = generateVapidKeys();
  const now = Date.UTC(2030, 0, 1);
  const header = vapidAuthorization(
    "https://push.example.net/push/abc",
    keys,
    "mailto:a@example.net",
    now,
  );
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  expect(match).not.toBeNull();
  const [, encodedHeader = "", encodedClaims = "", signature = "", publicKey = ""] = match ?? [];
  expect(publicKey).toBe(keys.publicKey);
  const claims = JSON.parse(base64UrlDecode(encodedClaims).toString("utf8")) as Record<
    string,
    unknown
  >;
  expect(claims).toEqual({
    aud: "https://push.example.net",
    exp: now / 1000 + 12 * 60 * 60,
    sub: "mailto:a@example.net",
  });
  const raw = base64UrlDecode(keys.publicKey);
  const verifier = createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: base64UrlEncode(raw.subarray(1, 33)),
      y: base64UrlEncode(raw.subarray(33)),
    },
  });
  expect(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: verifier, dsaEncoding: "ieee-p1363" },
      base64UrlDecode(signature),
    ),
  ).toBe(true);
});

test("only HTTPS push services, or a loopback test service, are accepted", () => {
  expect(isAcceptablePushEndpoint("https://push.example.net/x")).toBe(true);
  expect(isAcceptablePushEndpoint("http://127.0.0.1:9000/x")).toBe(true);
  expect(isAcceptablePushEndpoint("http://10.0.0.5/x")).toBe(false);
  expect(isAcceptablePushEndpoint("file:///etc/passwd")).toBe(false);
  const keys = { p256dh: RFC_RECEIVER_PUBLIC, auth: RFC_AUTH };
  expect(isPushSubscription({ endpoint: "https://push.example.net/x", keys })).toBe(true);
  expect(
    isPushSubscription({ endpoint: "https://push.example.net/x", keys: { ...keys, auth: "x" } }),
  ).toBe(false);
  expect(isPushSubscription({ endpoint: "http://10.0.0.5/x", keys })).toBe(false);
  expect(isPushSubscription(null)).toBe(false);
});
