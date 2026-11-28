import type { HttpBindings } from "@hono/node-server";
import type { IncomingMessage } from "node:http";

export function incomingMessageWith(address: string, port: number): IncomingMessage {
  return { socket: { remoteAddress: address, remotePort: port } } as unknown as IncomingMessage;
}

export function incomingWith(address: string, port: number): HttpBindings {
  return { incoming: incomingMessageWith(address, port) } as unknown as HttpBindings;
}
