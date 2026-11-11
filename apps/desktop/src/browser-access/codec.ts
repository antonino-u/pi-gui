/**
 * JSON turns undefined arguments into null, which the host's IPC validators reject, so the
 * browser and its bridge window send undefined as this marker.
 */
const UNDEFINED_MARKER = { __piUndefined: true } as const;

export function encodeArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => (arg === undefined ? UNDEFINED_MARKER : arg));
}

export function decodeArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) =>
    arg !== null && typeof arg === "object" && (arg as { __piUndefined?: unknown }).__piUndefined
      ? undefined
      : arg,
  );
}

export function parseFrame(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
