import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: ["mobile.spec.ts", "publishing-ui.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3108",
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {},
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3108",
    url: "http://127.0.0.1:3108/api/dashboard",
    timeout: 30000,
    reuseExistingServer: false,
    env: { SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", APP_ORIGIN: "http://127.0.0.1:3108", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
