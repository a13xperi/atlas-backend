/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/../../tsconfig.test.json" }],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  clearMocks: true,
  setupFiles: ["<rootDir>/../../jest.env.js"],
};
