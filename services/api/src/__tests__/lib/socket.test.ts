/**
 * Socket.IO /alerts namespace unit tests
 * Tests: auth middleware, connection handler, emitToUser
 */

jest.mock("socket.io", () => ({
  Server: jest.fn(),
}));

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
}));

jest.mock("../../lib/config", () => ({
  config: { JWT_SECRET: "test-secret" },
}));

import jwt from "jsonwebtoken";
import type { Server as HttpServer } from "http";

let mockJwtVerify: jest.Mock = jwt.verify as jest.Mock;
let Server: jest.Mock;
let initSocket: typeof import("../../lib/socket").initSocket;
let emitToUser: typeof import("../../lib/socket").emitToUser;

function getMockNamespace() {
  const instance = Server.mock.results[0]?.value;
  if (!instance) throw new Error("Server was not instantiated");
  return instance.of.mock.results[0]?.value;
}

function getMiddleware() {
  return getMockNamespace().use.mock.calls[0][0];
}

function getConnectionHandler() {
  const ns = getMockNamespace();
  const call = ns.on.mock.calls.find((c: any[]) => c[0] === "connection");
  return call?.[1];
}

describe("socket alerts namespace", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    mockJwtVerify = require("jsonwebtoken").verify as jest.Mock;
    ({ Server } = require("socket.io"));
    Server.mockImplementation(() => ({
      of: jest.fn().mockReturnValue({
        use: jest.fn(),
        on: jest.fn(),
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }),
    }));

    const socketMod = await import("../../lib/socket");
    initSocket = socketMod.initSocket;
    emitToUser = socketMod.emitToUser;
  });

  it("auth middleware rejects connection with no token", () => {
    initSocket({} as HttpServer, ["http://localhost"]);
    const middleware = getMiddleware();
    const socket = {
      handshake: { auth: {}, query: {} },
    } as any;
    const next = jest.fn();

    middleware(socket, next);

    expect(next).toHaveBeenCalledWith(new Error("Authentication required"));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("auth middleware rejects connection with invalid token", () => {
    mockJwtVerify.mockImplementation(() => {
      throw new Error("invalid");
    });
    initSocket({} as HttpServer, ["http://localhost"]);
    const middleware = getMiddleware();
    const socket = {
      handshake: { auth: { token: "bad-token" } },
    } as any;
    const next = jest.fn();

    middleware(socket, next);

    expect(next).toHaveBeenCalledWith(new Error("Invalid token"));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("auth middleware accepts connection with valid token and sets socket.userId", () => {
    mockJwtVerify.mockReturnValue({ userId: "user-1" });
    initSocket({} as HttpServer, ["http://localhost"]);
    const middleware = getMiddleware();
    const socket = {
      handshake: { auth: { token: "valid-token" } },
    } as any;
    const next = jest.fn();

    middleware(socket, next);

    expect(mockJwtVerify).toHaveBeenCalledWith("valid-token", "test-secret");
    expect(next).toHaveBeenCalledWith();
    expect(next).toHaveBeenCalledTimes(1);
    expect(socket.userId).toBe("user-1");
  });

  it("connection handler joins user room when socket.userId is set", () => {
    initSocket({} as HttpServer, ["http://localhost"]);
    const handler = getConnectionHandler();
    const socket = {
      userId: "user-1",
      join: jest.fn(),
      on: jest.fn(),
    } as any;

    handler(socket);

    expect(socket.join).toHaveBeenCalledWith("user:user-1");
  });

  it("emitToUser does nothing when io is null (before initSocket called)", () => {
    expect(() => emitToUser("user-1", "alert", { foo: "bar" })).not.toThrow();
  });

  it("emitToUser emits to correct namespace and room", () => {
    initSocket({} as HttpServer, ["http://localhost"]);
    emitToUser("user-1", "alert", { foo: "bar" });
    const ns = getMockNamespace();

    expect(ns.to).toHaveBeenCalledWith("user:user-1");
    expect(ns.emit).toHaveBeenCalledWith("alert", { foo: "bar" });
  });
});
