// Shared E2E fixture constants live in prisma/e2e-fixtures.ts so the demo
// seed can import them inside the Docker image build, where the e2e/
// directory is excluded by .dockerignore. This module re-exports them for
// the Playwright specs; keep importing from "./helpers/fixtures" in specs.
export * from "../../prisma/e2e-fixtures";
