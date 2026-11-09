import { expect, test } from "@playwright/test";
import {
  browserAccessBlockedMembers,
  browserAccessCallMembers,
  browserAccessEventMembers,
  browserAccessPolicy,
} from "../../contracts/browser-access";
import { parseBrowserAccessConfig } from "../../electron/browser-access/browser-access-config";
import {
  hostnameFromHostHeader,
  isAllowedHost,
  isLoopbackAddress,
  isSameOrigin,
  localHostnames,
  readCookie,
  secretsEqual,
} from "../../electron/browser-access/host-guard";

test("browser access stays off unless it is turned on", () => {
  expect(parseBrowserAccessConfig({})).toBeUndefined();
  expect(parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "0" })).toBeUndefined();
  expect(parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "off" })).toBeUndefined();
});

test("browser access listens on this machine only by default", () => {
  expect(parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "1" })).toEqual({
    host: "127.0.0.1",
    port: 7480,
    extraHostnames: [],
    pushContact: "https://github.com/minghinmatthewlam/pi-gui",
  });
  expect(parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "9000" })).toMatchObject({
    host: "127.0.0.1",
    port: 9000,
  });
});

test("browser access accepts an interface address and extra hostnames", () => {
  expect(
    parseBrowserAccessConfig({
      PI_APP_BROWSER_ACCESS: "10.0.0.5:8080",
      PI_APP_BROWSER_ACCESS_HOSTNAMES: " studio.home.arpa , ",
    }),
  ).toMatchObject({ host: "10.0.0.5", port: 8080, extraHostnames: ["studio.home.arpa"] });
  expect(parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "[::1]:8080" })).toMatchObject({
    host: "::1",
    port: 8080,
  });
});

test("browser access serves HTTPS only with both a certificate and a key", () => {
  expect(
    parseBrowserAccessConfig({
      PI_APP_BROWSER_ACCESS: "1",
      PI_APP_BROWSER_ACCESS_TLS_CERT: "/certs/host.pem",
      PI_APP_BROWSER_ACCESS_TLS_KEY: "/certs/host-key.pem",
      PI_APP_BROWSER_ACCESS_PUSH_CONTACT: "mailto:someone@example.net",
    }),
  ).toMatchObject({
    tls: { certFile: "/certs/host.pem", keyFile: "/certs/host-key.pem" },
    pushContact: "mailto:someone@example.net",
  });
  expect(() =>
    parseBrowserAccessConfig({
      PI_APP_BROWSER_ACCESS: "1",
      PI_APP_BROWSER_ACCESS_TLS_CERT: "/certs/host.pem",
    }),
  ).toThrow();
});

test("browser access rejects hostnames and invalid ports", () => {
  expect(() => parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "example.com:80" })).toThrow();
  expect(() => parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "70000" })).toThrow();
  expect(() => parseBrowserAccessConfig({ PI_APP_BROWSER_ACCESS: "nonsense" })).toThrow();
});

test("the Host header must name this machine", () => {
  const allowed = localHostnames(["studio.home.arpa"]);
  expect(isAllowedHost("127.0.0.1:7480", allowed)).toBe(true);
  expect(isAllowedHost("localhost:7480", allowed)).toBe(true);
  expect(isAllowedHost("[::1]:7480", allowed)).toBe(true);
  expect(isAllowedHost("STUDIO.home.arpa:7480", allowed)).toBe(true);
  expect(isAllowedHost("attacker.example:7480", allowed)).toBe(false);
  expect(isAllowedHost(undefined, allowed)).toBe(false);
  expect(hostnameFromHostHeader("[fe80::1]:80")).toBe("fe80::1");
  expect(hostnameFromHostHeader("fe80::1")).toBe("fe80::1");
});

test("sockets must come from the page's own origin", () => {
  expect(isSameOrigin("http://127.0.0.1:7480", "127.0.0.1:7480")).toBe(true);
  expect(isSameOrigin("http://127.0.0.1:7481", "127.0.0.1:7480")).toBe(false);
  expect(isSameOrigin("http://attacker.example", "127.0.0.1:7480")).toBe(false);
  expect(isSameOrigin("null", "127.0.0.1:7480")).toBe(false);
  expect(isSameOrigin(undefined, "127.0.0.1:7480")).toBe(false);
});

test("secrets, cookies and loopback peers are compared exactly", () => {
  expect(secretsEqual("abc", "abc")).toBe(true);
  expect(secretsEqual("abd", "abc")).toBe(false);
  expect(secretsEqual("ab", "abc")).toBe(false);
  expect(secretsEqual(undefined, "abc")).toBe(false);
  expect(readCookie("a=1; pi_gui_browser=xyz; b=2", "pi_gui_browser")).toBe("xyz");
  expect(readCookie("pi_gui_browser_other=xyz", "pi_gui_browser")).toBeUndefined();
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isLoopbackAddress("10.0.0.5")).toBe(false);
});

test("members that act on the host's own screen are never forwarded", () => {
  for (const member of [
    "pickWorkspace",
    "pickComposerAttachments",
    "openWorkspaceInFinder",
    "openWorkspaceInEditor",
    "revealWorkspaceFile",
    "loginProvider",
    "relaunchApplication",
    "openSystemNotificationSettings",
  ] as const) {
    expect(browserAccessPolicy[member]).toBe("blocked");
    expect(browserAccessCallMembers).not.toContain(member);
  }
  expect(browserAccessBlockedMembers).toContain("pickWorkspace");
  expect(browserAccessEventMembers).toEqual(
    expect.arrayContaining(["onStateChanged", "onSelectedTranscriptChanged", "onTerminalData"]),
  );
  expect(browserAccessCallMembers).toEqual(
    expect.arrayContaining(["getState", "submitComposer", "cancelCurrentRun"]),
  );
});
