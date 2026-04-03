/**
 * WebSocket layer — BO #40 (WebSocket Real-Time Alerts).
 * Socket.IO with /alerts namespace, JWT auth middleware, and event emission.
 */

import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { config } from "./config";

let io: Server | null = null;

export function initSocket(server: HttpServer, allowedOrigins: string[]): void {
  io = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
    path: "/socket.io",
  });

  const alertsNs = io.of("/alerts");

  alertsNs.use((socket, next) => {
    // Auth via token in handshake auth or query param
    const token =
      socket.handshake.auth?.token || (socket.handshake.query?.token as string | undefined);
    if (!token) return next(new Error("Authentication required"));
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET) as { userId: string };
      (socket as any).userId = decoded.userId;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  alertsNs.on("connection", (socket: Socket) => {
    const userId = (socket as any).userId;
    if (userId) socket.join(`user:${userId}`);
    socket.on("disconnect", () => {});
  });
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.of("/alerts").to(`user:${userId}`).emit(event, data);
}
