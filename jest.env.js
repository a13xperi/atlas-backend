// Set required env vars for test suite
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/atlas_test";
