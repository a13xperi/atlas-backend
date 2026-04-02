/**
 * WebSocket layer — stub for BO #40 (WebSocket Real-Time Alerts).
 * Currently a no-op so the build compiles. Full implementation will add
 * socket.io with /alerts namespace, auth middleware, and event emission.
 */

import type { Server as HttpServer } from "http";

export function initSocket(_server: HttpServer, _allowedOrigins: string[]): void {
  // No-op until BO #40 is implemented
}
