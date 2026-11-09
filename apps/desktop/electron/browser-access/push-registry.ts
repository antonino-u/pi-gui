import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  generateVapidKeys,
  isPushSubscription,
  type StoredPushSubscription,
  type VapidKeys,
} from "./web-push";

const MAX_SUBSCRIPTIONS = 20;

interface PushRegistryFile {
  readonly version: 1;
  readonly vapid: VapidKeys;
  readonly subscriptions: readonly (StoredPushSubscription & { readonly createdAt: string })[];
}

function isVapidKeys(value: unknown): value is VapidKeys {
  const candidate = value as Partial<VapidKeys> | undefined;
  return typeof candidate?.publicKey === "string" && typeof candidate.privateKey === "string";
}

/**
 * The host's VAPID key pair and the browsers subscribed to its push messages, kept in one
 * file readable by this user only. Subscriptions are capped; the oldest go first.
 */
export class PushRegistry {
  private data: PushRegistryFile | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<PushRegistryFile>;
      if (parsed.version === 1 && isVapidKeys(parsed.vapid)) {
        const subscriptions = (parsed.subscriptions ?? []).filter(isPushSubscription);
        this.data = {
          version: 1,
          vapid: parsed.vapid,
          subscriptions: subscriptions.map((entry) => ({
            endpoint: entry.endpoint,
            keys: { p256dh: entry.keys.p256dh, auth: entry.keys.auth },
            createdAt:
              typeof (entry as { createdAt?: unknown }).createdAt === "string"
                ? (entry as { createdAt: string }).createdAt
                : new Date().toISOString(),
          })),
        };
        return;
      }
    } catch {
      // Missing or unreadable: start over with a new key pair below.
    }
    this.data = { version: 1, vapid: generateVapidKeys(), subscriptions: [] };
    await this.save();
  }

  get vapid(): VapidKeys {
    return this.loaded().vapid;
  }

  subscriptions(): readonly StoredPushSubscription[] {
    return this.loaded().subscriptions;
  }

  async add(subscription: StoredPushSubscription): Promise<void> {
    const current = this.loaded();
    const others = current.subscriptions.filter(
      (entry) => entry.endpoint !== subscription.endpoint,
    );
    const next = [
      ...others,
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        createdAt: new Date().toISOString(),
      },
    ].slice(-MAX_SUBSCRIPTIONS);
    this.data = { ...current, subscriptions: next };
    await this.save();
  }

  async remove(endpoint: string): Promise<void> {
    const current = this.loaded();
    const next = current.subscriptions.filter((entry) => entry.endpoint !== endpoint);
    if (next.length === current.subscriptions.length) return;
    this.data = { ...current, subscriptions: next };
    await this.save();
  }

  private loaded(): PushRegistryFile {
    if (!this.data) throw new Error("The push registry is not loaded.");
    return this.data;
  }

  private save(): Promise<void> {
    const snapshot = this.loaded();
    const write = async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
    };
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}
