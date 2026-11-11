import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { BrowserAccessServer } from "../../electron/browser-access/browser-access-server";

const fixtures = join(__dirname, "..", "fixtures", "browser-access-tls");

interface HttpsResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function get(port: number, path: string, ca: Buffer, cookie?: string): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path,
        ca,
        headers: { Host: `127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}) },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function startServer(options: { readonly legacyToken?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-access-"));
  const renderer = join(directory, "renderer");
  const scripts = join(directory, "scripts");
  await writeFile(join(directory, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await mkdir(renderer);
  await mkdir(scripts);
  await writeFile(
    join(renderer, "index.html"),
    "<!doctype html><html><head></head><body></body></html>",
  );
  await writeFile(join(scripts, "client.js"), "/* client */");
  await writeFile(join(scripts, "bridge.js"), "/* bridge */");
  await writeFile(join(scripts, "service-worker.js"), "/* showNotification */");
  if (options.legacyToken) {
    await writeFile(
      join(directory, "browser-access.json"),
      JSON.stringify({ version: 1, token: options.legacyToken }),
    );
  }
  const ca = await readFile(join(fixtures, "cert.pem"));
  const server = new BrowserAccessServer({
    host: "127.0.0.1",
    port: 0,
    tokenFile: join(directory, "browser-access.json"),
    devicesFile: join(directory, "browser-devices.json"),
    pushFile: join(directory, "browser-push.json"),
    scriptsDir: scripts,
    pushContact: "mailto:someone@example.net",
    iconFile: join(directory, "icon.png"),
    tls: { cert: ca, key: await readFile(join(fixtures, "key.pem")) },
    renderer: { kind: "directory", root: renderer },
    openBridgeWindow: () => {
      throw new Error("No browser tab connects in this test.");
    },
  });
  await server.start();
  return { server, ca, directory };
}

const pathOf = (url: string | undefined) => {
  const parsed = new URL(url ?? "");
  return parsed.pathname + parsed.search;
};
const cookieOf = (result: HttpsResult) =>
  String(result.headers["set-cookie"] ?? "").split(";")[0] ?? "";

test("browser access serves HTTPS, pairs a device with its own key and installs as a web app", async () => {
  const { server, ca, directory } = await startServer();
  try {
    const [pairingUrl] = server.pairingUrls();
    expect(pairingUrl).toMatch(
      /^https:\/\/127\.0\.0\.1:\d+\/__pi-browser\/pair\?token=[a-f0-9]{64}$/,
    );
    const pairingKey = new URL(pairingUrl ?? "").searchParams.get("token") ?? "";

    const unpairedManifest = await get(server.port, "/__pi-browser/manifest.webmanifest", ca);
    expect(JSON.parse(unpairedManifest.body)).toMatchObject({
      start_url: "/",
      display: "standalone",
    });
    // An unpaired browser that opens the address gets the page that asks for a code.
    const unpaired = await get(server.port, "/", ca);
    expect(unpaired.status).toBe(302);
    expect(unpaired.headers.location).toBe("/__pi-browser/pair");
    expect((await get(server.port, "/__pi-browser/pair", ca)).body).toContain("Pairing code");
    expect((await get(server.port, "/assets/app.js", ca)).status).toBe(403);

    const paired = await get(server.port, pathOf(pairingUrl), ca);
    expect(paired.status).toBe(302);
    const setCookie = String(paired.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    const cookie = cookieOf(paired);
    // The device gets its own key; the pairing link's key never becomes a cookie.
    expect(cookie).toMatch(/^pi_gui_browser=[a-f0-9]{64}$/);
    expect(cookie).not.toContain(pairingKey);
    expect(server.status()).toMatchObject({ enabled: true, https: true, devices: [{}] });

    const page = await get(server.port, "/", ca, cookie);
    expect(page.status).toBe(200);
    const push = JSON.parse(await readFile(join(directory, "browser-push.json"), "utf8")) as {
      vapid: { publicKey: string };
    };
    expect(page.body).toContain(
      `<script src="/__pi-browser/client.js" data-push-key="${push.vapid.publicKey}"></script>`,
    );
    expect(page.body).toContain('rel="manifest"');
    expect(page.body).toContain('rel="apple-touch-icon"');

    // A Home Screen app keeps its own cookies, so its start URL pairs it again as this device.
    const manifest = JSON.parse(
      (await get(server.port, "/__pi-browser/manifest.webmanifest", ca, cookie)).body,
    ) as { start_url: string };
    expect(manifest.start_url).toBe(`/__pi-browser/pair?token=${cookie.split("=")[1]}`);
    const relaunched = await get(server.port, manifest.start_url, ca);
    expect(cookieOf(relaunched)).toBe(cookie);
    expect(server.status()).toMatchObject({ devices: [{}] });

    const worker = await get(server.port, "/__pi-browser/sw.js", ca);
    expect(worker.status).toBe(200);
    expect(worker.headers["service-worker-allowed"]).toBe("/");
    expect(worker.body).toContain("showNotification");
    expect((await get(server.port, "/__pi-browser/client.js", ca)).status).toBe(200);

    // Bridge windows use a separate loopback listener; the browser-facing port has no bridge.
    expect((await get(server.port, "/__pi-browser/bridge?tab=x&key=y", ca, cookie)).status).toBe(
      404,
    );
  } finally {
    await server.stop();
  }
});

test("a pairing code works once, and revoking a device unpairs only that device", async () => {
  const { server, ca } = await startServer();
  try {
    const pairing = server.createPairingCode();
    expect(pairing.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(pairing.qrSvg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    expect(pairing.url).toContain(`/__pi-browser/pair?code=${pairing.code}`);

    const wrong = await get(server.port, "/__pi-browser/pair?code=AAAAAAAA", ca);
    expect(wrong.status).toBe(403);
    expect(wrong.body).toContain("not valid or has expired");
    // Case, spaces and dashes in a typed code do not matter.
    const typed = `${pairing.code.slice(0, 4).toLowerCase()}-${pairing.code.slice(4)}`;
    const first = await get(
      server.port,
      `/__pi-browser/pair?code=${encodeURIComponent(typed)}`,
      ca,
    );
    expect(first.status).toBe(302);
    const reused = await get(server.port, `/__pi-browser/pair?code=${pairing.code}`, ca);
    expect(reused.status).toBe(403);

    const second = await get(server.port, pathOf(server.pairingUrls()[0]), ca);
    const status = server.status();
    if (!status.enabled) throw new Error("Browser access should be on");
    expect(status.devices).toHaveLength(2);
    const firstCookie = cookieOf(first);
    const secondCookie = cookieOf(second);

    const [newest] = status.devices;
    await server.revokeDevice(newest?.id ?? "");
    const results = await Promise.all(
      [firstCookie, secondCookie].map(
        async (cookie) => (await get(server.port, "/", ca, cookie)).status,
      ),
    );
    expect(results.sort()).toEqual([200, 302]);

    // A new pairing link replaces the old one; the remaining device stays paired.
    const oldLink = pathOf(server.pairingUrls()[0]);
    await server.resetPairingLink();
    expect((await get(server.port, oldLink, ca)).status).toBe(403);
    expect(pathOf(server.pairingUrls()[0])).not.toBe(oldLink);
    const remaining = results[0] === 200 ? firstCookie : secondCookie;
    expect((await get(server.port, "/", ca, remaining)).status).toBe(200);
  } finally {
    await server.stop();
  }
});

test("a browser paired before devices had their own keys stays paired", async () => {
  const legacyToken = "a".repeat(64);
  const { server, ca } = await startServer({ legacyToken });
  try {
    expect((await get(server.port, "/", ca, `pi_gui_browser=${legacyToken}`)).status).toBe(200);
    expect(server.status()).toMatchObject({
      devices: [{ name: "Paired before the device list" }],
    });
    // The reusable link no longer carries that device's key.
    expect(server.pairingUrls()[0]).not.toContain(legacyToken);
  } finally {
    await server.stop();
  }
});
