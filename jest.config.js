/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/services/api/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  clearMocks: true,
  collectCoverageFrom: [
    "services/api/src/**/*.ts",
    "!services/api/src/__tests__/**",
  ],
  coverageReporters: ["text", "lcov", "json-summary"],
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      statements: 48,
      branches: 58,
      functions: 55,
      lines: 48,
    },
    "./services/api/src/routes/": {
      statements: 94,
      branches: 82,
      functions: 93,
      lines: 94,
    },
    "./services/api/src/middleware/": {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
