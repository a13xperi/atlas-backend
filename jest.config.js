const path = require("path");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  rootDir: __dirname,
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/services/api/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: path.join(__dirname, "tsconfig.test.json") }],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  clearMocks: true,
  setupFiles: ["<rootDir>/jest.env.js"],
};
