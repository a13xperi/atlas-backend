/**
 * Socket alerts unit tests
 * Tests: initSocket auth middleware, connection handler, emitToUser
 */

import jwt from "jsonwebtoken";
import { Server } from "socket.io";

jest.mock("../lib/config", () => ({
  config: { JWT_SECRET: "test-secret", NODE_ENV: "test" },
}));

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
}));

jest.mock("socket.io", () => ({
  Server: jest.fn(),
}));

import { initSocket, emitToUser } from "../lib/socket";

const MockedServer = Server as jest.MockedClass<typeof Server>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

describe("socket alerts", () => {
  let mockUse: jest.Mock;
  let mockOn: jest.Mock;
  let mockEmit: jest.Mock;
  let mockTo: jest.Mock;

  beforeEach(() => {
    mockUse = jest.fn();
    mockOn = jest.fn();
    mockEmit = jest.fn();
    mockTo = jest.fn().mockReturnValue({ emit: mockEmit });

    (MockedServer as any).mockImplementation(() => ({
      of: jest.fn().mockReturnValue({
        use: mockUse,
        on: mockOn,
        to: mockTo,
      }),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("Auth middleware: valid JWT → calls next() with no arguments", () => {
    initSocket({} as any, ["http://localhost"]);
    const middleware = mockUse.mock.calls[0][0];
    const socket: any = { handshake: { auth: { token: "valid-token" } }, join: jest.fn() };
    const next = jest.fn();

    (mockJwt.verify as jest.Mock).mockReturnValueOnce({ userId: "user-1" });
    middleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.userId).toBe("user-1");
  });

  it('Auth middleware: no token → calls next(new Error("Authentication required"))', () => {
    initSocket({} as any, ["http://localhost"]);
    const middleware = mockUse.mock.calls[0][0];
    const socket: any = { handshake: {} };
    const next = jest.fn();

    middleware(socket, next);

    expect(next).toHaveBeenCalledWith(new Error("Authentication required"));
  });

  it('Auth middleware: invalid JWT → calls next(new Error("Invalid token"))', () => {
    initSocket({} as any, ["http://localhost"]);
    const middleware = mockUse.mock.calls[0][0];
    const socket: any = { handshake: { auth: { token: "bad-token" } } };
    const next = jest.fn();

    (mockJwt.verify as jest.Mock).mockImplementationOnce(() => {
      throw new Error("invalid");
    });
    middleware(socket, next);

    expect(next).toHaveBeenCalledWith(new Error("Invalid token"));
  });

  it("Connection event: authenticated socket joins correct room user:${userId}", () => {
    initSocket({} as any, ["http://localhost"]);
    const connectionHandler = mockOn.mock.calls.find((call) => call[0] === "connection")![1];
    const socket: any = { join: jest.fn(), on: jest.fn() };
    socket.userId = "user-1";

    connectionHandler(socket);

    expect(socket.join).toHaveBeenCalledWith("user:user-1");
  });

  it("emitToUser: emits to correct namespace room", () => {
    initSocket({} as any, ["http://localhost"]);
    emitToUser("user-1", "alert", { msg: "hello" });

    expect(mockTo).toHaveBeenCalledWith("user:user-1");
    expect(mockEmit).toHaveBeenCalledWith("alert", { msg: "hello" });
  });
});
