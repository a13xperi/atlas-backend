import request from "supertest";
import express from "express";
import { adminBackupRouter } from "../../routes/admin-backup";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";
import { AppError } from "../../lib/errors";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("../../lib/backup", () => ({
  getBackupConfigurationSummary: jest.fn(() => ({
    preferredStrategy: "local-logical",
    supabaseRestorePointConfigured: false,
    r2Configured: false,
    localBackupDir: "/tmp/backups",
    retentionDays: 30,
  })),
  getLatestBackupLog: jest.fn(),
  serializeBackupLog: jest.fn((log: any) =>
    log
      ? {
          ...log,
          triggeredAt: new Date(log.triggeredAt).toISOString(),
          completedAt: log.completedAt ? new Date(log.completedAt).toISOString() : null,
        }
      : null
  ),
  triggerBackup: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import {
  getLatestBackupLog,
  triggerBackup,
} from "../../lib/backup";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetLatestBackupLog = getLatestBackupLog as jest.MockedFunction<typeof getLatestBackupLog>;
const mockTriggerBackup = triggerBackup as jest.MockedFunction<typeof triggerBackup>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/admin/backup", adminBackupRouter);

const AUTH = { Authorization: "Bearer mock-token" };

describe("admin backup routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 on trigger without an auth token", async () => {
    const res = await request(app).post("/api/admin/backup/trigger");
    expect(res.status).toBe(401);
  });

  it("returns 403 on trigger for non-admin users", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });

    const res = await request(app).post("/api/admin/backup/trigger").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns 400 on trigger for an invalid request body", async () => {
    const res = await request(app)
      .post("/api/admin/backup/trigger")
      .set(AUTH)
      .send({ reason: 123 });

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("triggers a backup for admins", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "ADMIN" });
    mockTriggerBackup.mockResolvedValueOnce({
      id: "backup-1",
      triggeredAt: new Date("2026-04-09T02:00:00.000Z"),
      status: "SUCCESS",
      triggerSource: "MANUAL",
      provider: "LOCAL_LOGICAL",
      size: 2048,
      storageUrl: "file:///tmp/backups/atlas-backup.sql.gz",
      errorMessage: null,
      completedAt: new Date("2026-04-09T02:00:05.000Z"),
    } as any);

    const res = await request(app)
      .post("/api/admin/backup/trigger")
      .set(AUTH)
      .send({ reason: "pre-deploy snapshot" });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.backup.id).toBe("backup-1");
    expect(data.backup.status).toBe("SUCCESS");
    expect(mockTriggerBackup).toHaveBeenCalledWith({ triggerSource: "MANUAL" });
  });

  it("returns 409 when another backup is already running", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "ADMIN" });
    mockTriggerBackup.mockRejectedValueOnce(AppError.conflict("Backup already in progress"));

    const res = await request(app).post("/api/admin/backup/trigger").set(AUTH);

    expect(res.status).toBe(409);
    expectErrorResponse(res.body, "Backup already in progress");
  });

  it("returns latest backup status for admins", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "ADMIN" });
    mockGetLatestBackupLog.mockResolvedValueOnce({
      id: "backup-2",
      triggeredAt: new Date("2026-04-09T02:00:00.000Z"),
      status: "SUCCESS",
      triggerSource: "SCHEDULED",
      provider: "R2_LOGICAL",
      size: 4096,
      storageUrl: "r2://atlas-backups/2026/04/atlas-backup.sql.gz",
      errorMessage: null,
      completedAt: new Date("2026-04-09T02:00:06.000Z"),
    } as any);

    const res = await request(app).get("/api/admin/backup/status").set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.backup.id).toBe("backup-2");
    expect(data.backup.triggerSource).toBe("SCHEDULED");
  });
});
