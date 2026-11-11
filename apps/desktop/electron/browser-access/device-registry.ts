import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { BrowserDeviceInfo } from "../../contracts/browser-access";
import { secretsEqual } from "./host-guard";
import { readJsonFile, SerialWriter } from "./secure-file";

/** Letters and digits that cannot be misread for each other (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** Wrong codes allowed while codes are outstanding; past this every code is cancelled. */
const MAX_FAILED_CODES = 10;
/** How often a device's last-seen time is written, at most. */
const LAST_SEEN_WRITE_MS = 60_000;
const MAX_DEVICES = 50;

interface StoredDevice {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly pairedAt: string;
  lastSeenAt: string;
}

interface DevicesFile {
  readonly version: 1;
  readonly devices: readonly StoredDevice[];
}

interface PendingCode {
  readonly code: string;
  readonly expiresAt: number;
}

export interface PairedDevice {
  readonly id: string;
  /** The device's own secret, for its cookie and its Home Screen start URL. */
  readonly token: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isStoredDevice(value: unknown): value is StoredDevice {
  const device = value as Partial<StoredDevice> | null;
  return (
    typeof device?.id === "string" &&
    typeof device.name === "string" &&
    typeof device.tokenHash === "string" &&
    /^[a-f0-9]{64}$/.test(device.tokenHash) &&
    typeof device.pairedAt === "string" &&
    typeof device.lastSeenAt === "string"
  );
}

/** A short, readable name such as "iPhone · Safari", from the browser's user agent. */
export function deviceNameFromUserAgent(userAgent: string | undefined): string {
  const agent = userAgent ?? "";
  const device = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Macintosh|Mac OS X/.test(agent)
          ? "Mac"
          : /Windows/.test(agent)
            ? "Windows"
            : /Linux/.test(agent)
              ? "Linux"
              : "Browser";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(agent)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : undefined;
  return browser ? `${device} · ${browser}` : device;
}

/**
 * The devices paired with browser access. Each device has its own secret, kept here only as a
 * SHA-256 hash, so one device can be revoked without the others. A device pairs with a short
 * code that works once and expires, or with the host's pairing link (the launcher's QR code).
 */
export class DeviceRegistry {
  private devices: StoredDevice[] = [];
  private codes: PendingCode[] = [];
  private failedCodes = 0;
  private readonly writer: SerialWriter;
  private readonly lastSeenWritten = new Map<string, number>();

  constructor(private readonly file: string) {
    this.writer = new SerialWriter(file);
  }

  /**
   * Loads the device list. With no list yet, a browser paired by an earlier version holds the
   * old pairing link's key as its cookie; `legacyToken` keeps it working as one device.
   * Returns true when it did that, so the caller gives the pairing link a new key.
   */
  async load(legacyToken?: string): Promise<boolean> {
    const parsed = (await readJsonFile(this.file)) as Partial<DevicesFile> | undefined;
    if (parsed?.version === 1 && Array.isArray(parsed.devices)) {
      this.devices = parsed.devices.filter(isStoredDevice).map((device) => ({ ...device }));
      return false;
    }
    this.devices = [];
    if (legacyToken) {
      const now = new Date().toISOString();
      this.devices.push({
        id: randomUUID(),
        name: "Paired before the device list",
        tokenHash: hashToken(legacyToken),
        pairedAt: now,
        lastSeenAt: now,
      });
    }
    await this.save();
    return Boolean(legacyToken);
  }

  list(): readonly BrowserDeviceInfo[] {
    return this.devices.map(({ id, name, pairedAt, lastSeenAt }) => ({
      id,
      name,
      pairedAt,
      lastSeenAt,
    }));
  }

  /** The device a cookie or start-URL secret belongs to. */
  deviceForToken(token: string | undefined): string | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const hash = hashToken(token);
    return this.devices.find((device) => secretsEqual(device.tokenHash, hash))?.id;
  }

  async addDevice(userAgent: string | undefined): Promise<PairedDevice> {
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const device: StoredDevice = {
      id: randomUUID(),
      name: deviceNameFromUserAgent(userAgent),
      tokenHash: hashToken(token),
      pairedAt: now,
      lastSeenAt: now,
    };
    this.devices = [...this.devices, device].slice(-MAX_DEVICES);
    await this.save();
    return { id: device.id, token };
  }

  /** Gives an existing device a new secret, for a request that proved it holds the old one. */
  async rotateToken(deviceId: string): Promise<PairedDevice | undefined> {
    const index = this.devices.findIndex((device) => device.id === deviceId);
    const device = this.devices[index];
    if (!device) return undefined;
    const token = randomBytes(32).toString("hex");
    this.devices[index] = { ...device, tokenHash: hashToken(token) };
    await this.save();
    return { id: deviceId, token };
  }

  async revoke(deviceId: string): Promise<boolean> {
    const next = this.devices.filter((device) => device.id !== deviceId);
    if (next.length === this.devices.length) return false;
    this.devices = next;
    this.lastSeenWritten.delete(deviceId);
    await this.save();
    return true;
  }

  markSeen(deviceId: string, now: number = Date.now()): void {
    const device = this.devices.find((entry) => entry.id === deviceId);
    if (!device) return;
    device.lastSeenAt = new Date(now).toISOString();
    if (now - (this.lastSeenWritten.get(deviceId) ?? 0) < LAST_SEEN_WRITE_MS) return;
    this.lastSeenWritten.set(deviceId, now);
    void this.save().catch((error: unknown) => {
      console.warn("[browser-access] could not save the device list", error);
    });
  }

  /** A new one-time pairing code. Earlier codes stay valid until they are used or expire. */
  createCode(now: number = Date.now()): PendingCode {
    this.dropExpiredCodes(now);
    let code = "";
    for (let index = 0; index < CODE_LENGTH; index += 1) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    const pending = { code, expiresAt: now + PAIRING_CODE_TTL_MS };
    this.codes.push(pending);
    return pending;
  }

  /** Uses up a pairing code. Spaces, dashes and letter case are ignored. */
  consumeCode(entered: string, now: number = Date.now()): boolean {
    this.dropExpiredCodes(now);
    const normalized = entered.toUpperCase().replace(/[\s-]/g, "");
    const match = this.codes.find((pending) => secretsEqual(normalized, pending.code));
    if (match) {
      this.codes = this.codes.filter((pending) => pending !== match);
      return true;
    }
    if (this.codes.length > 0) {
      this.failedCodes += 1;
      if (this.failedCodes >= MAX_FAILED_CODES) {
        this.codes = [];
        this.failedCodes = 0;
      }
    }
    return false;
  }

  private dropExpiredCodes(now: number): void {
    this.codes = this.codes.filter((pending) => pending.expiresAt > now);
    if (this.codes.length === 0) this.failedCodes = 0;
  }

  private save(): Promise<void> {
    return this.writer.write({ version: 1, devices: this.devices } satisfies DevicesFile);
  }
}
