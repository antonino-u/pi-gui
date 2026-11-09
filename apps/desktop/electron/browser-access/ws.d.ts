// The subset of the `ws` package (which ships no types) that browser access uses.
declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket {
    static readonly OPEN: 1;
    readonly readyState: 0 | 1 | 2 | 3;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(
      event: "message",
      listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
    ): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export interface WebSocketServerOptions {
    readonly noServer: true;
    readonly maxPayload?: number;
    readonly perMessageDeflate?: boolean | { readonly threshold?: number };
  }

  export class WebSocketServer {
    constructor(options: WebSocketServerOptions);
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket, request: IncomingMessage) => void,
    ): void;
    close(): void;
  }
}
