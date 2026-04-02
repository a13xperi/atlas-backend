import { AppError, isAppError, mapPrismaError, isPrismaError, formatErrorResponse } from "../../lib/errors";
import { Prisma } from "@prisma/client";

describe("AppError", () => {
  it("should create error with status code and code", () => {
    const err = new AppError(404, "NOT_FOUND", "User not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("User not found");
    expect(err.name).toBe("AppError");
  });

  it("should have static factory methods", () => {
    expect(AppError.notFound().statusCode).toBe(404);
    expect(AppError.conflict().statusCode).toBe(409);
    expect(AppError.badRequest("bad").statusCode).toBe(400);
    expect(AppError.forbidden().statusCode).toBe(403);
    expect(AppError.unauthorized().statusCode).toBe(401);
  });

  it("should include details", () => {
    const err = AppError.badRequest("Invalid", { field: "email" });
    expect(err.details).toEqual({ field: "email" });
  });
});

describe("isAppError", () => {
  it("should return true for AppError instances", () => {
    expect(isAppError(AppError.notFound())).toBe(true);
  });

  it("should return false for regular errors", () => {
    expect(isAppError(new Error("test"))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("string")).toBe(false);
  });
});

describe("mapPrismaError", () => {
  it("should map P2002 to 409 conflict", () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
      meta: { target: ["email"] },
    });
    const result = mapPrismaError(prismaErr);
    expect(result.statusCode).toBe(409);
    expect(result.code).toBe("UNIQUE_CONSTRAINT_VIOLATION");
    expect(result.message).toContain("email");
  });

  it("should map P2025 to 404 not found", () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "5.0.0",
    });
    const result = mapPrismaError(prismaErr);
    expect(result.statusCode).toBe(404);
    expect(result.code).toBe("RECORD_NOT_FOUND");
  });

  it("should map P2003 to 400 foreign key violation", () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError("Foreign key failed", {
      code: "P2003",
      clientVersion: "5.0.0",
    });
    const result = mapPrismaError(prismaErr);
    expect(result.statusCode).toBe(400);
    expect(result.code).toBe("FOREIGN_KEY_VIOLATION");
  });

  it("should map unknown codes to 500", () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError("Unknown", {
      code: "P9999",
      clientVersion: "5.0.0",
    });
    const result = mapPrismaError(prismaErr);
    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("DATABASE_ERROR");
  });
});

describe("formatErrorResponse", () => {
  it("should format AppError", () => {
    const err = AppError.notFound("User not found");
    const { statusCode, body } = formatErrorResponse(err, "req-123");
    expect(statusCode).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.requestId).toBe("req-123");
  });

  it("should format Prisma errors", () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: "5.0.0",
      meta: { target: ["handle"] },
    });
    const { statusCode, body } = formatErrorResponse(prismaErr);
    expect(statusCode).toBe(409);
    expect(body.code).toBe("UNIQUE_CONSTRAINT_VIOLATION");
  });

  it("should format generic errors as 500", () => {
    const { statusCode, body } = formatErrorResponse(new Error("boom"));
    expect(statusCode).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("should format ZodError-like objects as 400", () => {
    const zodLike = { issues: [{ path: ["name"], message: "Required" }] };
    const { statusCode, body } = formatErrorResponse(zodLike);
    expect(statusCode).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});
