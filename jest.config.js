/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/scripts"],
  testMatch: ["**/*.test.ts"],
  passWithNoTests: true,
  // Several test files share one real local Postgres instance (docker-compose)
  // and truncate common tables between tests — running test files in
  // parallel workers races those truncates against each other.
  maxWorkers: 1,
};
