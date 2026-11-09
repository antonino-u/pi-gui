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

async function startServer() {
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-access-"));
  const renderer = join(directory, "renderer");
  await writeFile(join(directory, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await mkdir(renderer);
  await writeFile(
    join(renderer, "index.html"),
    "<!doctype html><html><head></head><body></body></html>",
  );
  const ca = await readFile(join(fixtures, "cert.pem"));
  const server = new BrowserAccessServer({
    host: "127.0.0.1",
    port: 0,
    tokenFile: join(directory, "browser-access.json"),
    pushFile: join(directory, "browser-push.json"),
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

test("browser access serves HTTPS, pairs with a secure cookie and installs as a web app", async () => {
  const { server, ca, directory } = await startServer();
  try {
    const [pairingUrl] = server.pairingUrls();
    expect(pairingUrl).toMatch(
      /^https:\/\/127\.0\.0\.1:\d+\/__pi-browser\/pair\?token=[a-f0-9]{64}$/,
    );
    const pairPath = new URL(pairingUrl ?? "").pathname + new URL(pairingUrl ?? "").search;

    const unpairedManifest = await get(server.port, "/__pi-browser/manifest.webmanifest", ca);
    expect(unpairedManifest.status).toBe(200);
    expect(JSON.parse(unpairedManifest.body)).toMatchObject({
      start_url: "/",
      display: "standalone",
    });
    expect((await get(server.port, "/", ca)).status).toBe(403);

    const paired = await get(server.port, pairPath, ca);
    expect(paired.status).toBe(302);
    const setCookie = String(paired.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0] ?? "";

    const page = await get(server.port, "/", ca, cookie);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script src="/__pi-browser/client.js"></script>');
    expect(page.body).toContain('rel="manifest"');
    expect(page.body).toContain('rel="apple-touch-icon"');

    // A Home Screen app keeps its own cookies, so its start URL pairs it again.
    const manifest = JSON.parse(
      (await get(server.port, "/__pi-browser/manifest.webmanifest", ca, cookie)).body,
    ) as { start_url: string };
    expect(manifest.start_url).toBe(pairPath);

    const worker = await get(server.port, "/__pi-browser/sw.js", ca);
    expect(worker.status).toBe(200);
    expect(worker.headers["service-worker-allowed"]).toBe("/");
    expect(worker.body).toContain("showNotification");

    const client = await get(server.port, "/__pi-browser/client.js", ca, cookie);
    const push = JSON.parse(await readFile(join(directory, "browser-push.json"), "utf8")) as {
      vapid: { publicKey: string };
    };
    expect(client.body).toContain(push.vapid.publicKey);

    // Bridge windows use a separate loopback listener; the browser-facing port has no bridge.
    expect((await get(server.port, "/__pi-browser/bridge?tab=x&key=y", ca, cookie)).status).toBe(
      404,
    );
  } finally {
    await server.stop();
  }
});
