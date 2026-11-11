import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Reads a JSON file, or returns undefined when it is missing or unreadable. */
export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Replaces a JSON file atomically, readable by this user only. */
export async function writeSecureJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

/** Serializes writes to one file, so a slow write never lands after a newer one. */
export class SerialWriter {
  private last: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  write(value: unknown): Promise<void> {
    const write = () => writeSecureJsonFile(this.file, value);
    this.last = this.last.then(write, write);
    return this.last;
  }
}
