import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // CI runners are colder than local — server-action redirects can lose a
  // navigation event on first run. Two retries on CI papers over those
  // timing flakes without masking real failures (real bugs reproduce
  // consistently on all 3 attempts).
  retries: process.env.CI ? 2 : 0,
  // One worker. One test at a time. Strictly serial — Next/Turbopack with
  // multiple concurrent compiles is what was leaking ~30 postcss workers
  // per run on macOS.
  workers: 1,
  // Locally, bail after the first failure so we don't keep recompiling for
  // tests that depend on the same state. On CI, run the whole suite so we
  // see every regression in one report.
  maxFailures: process.env.CI ? undefined : 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: path.resolve(__dirname, "./e2e/global-setup.ts"),
  globalTeardown: path.resolve(__dirname, "./e2e/global-teardown.ts"),
  use: {
    baseURL,
    storageState: path.resolve(__dirname, "./e2e/.auth/user.json"),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Production server (`next build` → `next start`). Dev-mode bundlers
    // on this app are broken: Turbopack leaks unbounded memory via PostCSS
    // workers per request; webpack can't bundle @azure/monitor-opentelemetry's
    // optional deps. Production builds are stable on both fronts.
    // The script builds on first run, reuses build/ on subsequent runs.
    command: "./e2e/start-prod-server.sh",
    url: baseURL,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 240_000,
    env: {
      NODE_ENV: "production",
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "test-nextauth-secret-do-not-use-in-prod",
      NEXTAUTH_URL: baseURL,
      AZURECHAT_TEST_BACKEND: "memory",
      // Opt in to fakes even though NODE_ENV=production (E2E runs against
      // the production build; the security guard in instrumentation.ts
      // refuses otherwise).
      AZURECHAT_E2E_ALLOW_FAKES: "1",
      AZURE_COSMOSDB_URI: "https://cosmos.test.local",
      AZURE_COSMOSDB_KEY: "test-key",
      AZURE_COSMOSDB_DB_NAME: "chat",
      AZURE_COSMOSDB_CONTAINER_NAME: "history",
      AZURE_COSMOSDB_CONFIG_CONTAINER_NAME: "config",
      AZURE_OPENAI_API_KEY: "test-openai-key",
      AZURE_OPENAI_API_INSTANCE_NAME: "test-instance",
      AZURE_OPENAI_API_DEPLOYMENT_NAME: "gpt-test",
      // Per-model deployment names — MODEL_CONFIGS[*].deploymentName reads these
      // at process start; without them chat-api-response.ts returns
      // "Missing deployment configuration" before the fake OpenAI is invoked.
      // The fake is wired via webpack alias regardless of the value here.
      AZURE_OPENAI_API_GPT6_SOL_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_GPT6_LUNA_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_GPT56_SOL_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_GPT56_TERRA_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_GPT56_LUNA_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_GPT55_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_GPT54_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_GPT54_MINI_DEPLOYMENT_NAME: "gpt-test",
      AZURE_OPENAI_API_VERSION: "2024-10-21",
      AZURE_SEARCH_API_KEY: "test-search-key",
      AZURE_SEARCH_NAME: "test-search",
      AZURE_SEARCH_INDEX_NAME: "test-index",
      AZURE_KEY_VAULT_NAME: "test-kv",
      AZURE_STORAGE_ACCOUNT_NAME: "teststorage",
      AZURE_STORAGE_ACCOUNT_KEY: "test-storage-key",
      MAX_PERSONA_CI_DOCUMENT_LIMIT: "20",
      NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_LIMIT: "20",
      ADMIN_EMAIL_ADDRESS: "admin@example.com",
    },
  },
});
