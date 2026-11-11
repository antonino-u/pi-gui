/**
 * Runs in a hidden bridge window on the host, next to the real preload. It invokes only members
 * whose browser-access policy is `call`, and forwards every `event` member back to the browser.
 *
 * The host serves this file with the bridge socket address on the script tag (`data-socket`).
 */
import {
  browserAccessCallMembers,
  browserAccessEventMembers,
} from "../../contracts/browser-access";
import { decodeArgs, encodeArgs, errorMessage, parseFrame } from "./codec";

type Member = (...args: unknown[]) => unknown;

const socketUrl = document.currentScript?.dataset.socket ?? "";
const allowed = new Set<string>(browserAccessCallMembers);
const api = window.piApp as unknown as Record<string, Member | undefined>;
const outbox: string[] = [];
const socket = new WebSocket(socketUrl);

function send(frame: { readonly t: string; readonly id?: number } & Record<string, unknown>): void {
  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch {
    if (frame.t !== "result") return;
    text = JSON.stringify({
      t: "result",
      id: frame.id,
      ok: false,
      e: "The result could not be sent to the browser.",
    });
  }
  if (socket.readyState === WebSocket.OPEN) socket.send(text);
  else if (socket.readyState === WebSocket.CONNECTING) outbox.push(text);
}

socket.onopen = () => {
  for (const text of outbox.splice(0)) socket.send(text);
};

for (const member of browserAccessEventMembers) {
  api[member]?.((...payload: unknown[]) => send({ t: "event", m: member, p: encodeArgs(payload) }));
}

async function answer(id: number, member: string, args: unknown[]): Promise<void> {
  const method = api[member];
  if (!allowed.has(member) || !method) {
    send({ t: "result", id, ok: false, e: `${member} is not available in the browser.` });
    return;
  }
  try {
    send({ t: "result", id, ok: true, v: await method(...decodeArgs(args)) });
  } catch (error) {
    send({ t: "result", id, ok: false, e: errorMessage(error) });
  }
}

socket.onmessage = (message: MessageEvent<unknown>) => {
  const frame = parseFrame(message.data);
  if (frame?.t !== "call" || typeof frame.id !== "number" || typeof frame.m !== "string") return;
  if (!Array.isArray(frame.a)) return;
  answer(frame.id, frame.m, frame.a as unknown[]).catch((error: unknown) =>
    console.error("[pi-browser] bridge call failed", error),
  );
};
