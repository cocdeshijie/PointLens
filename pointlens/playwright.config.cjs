const { defineConfig } = require("@playwright/test")
module.exports = defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 20000,
  use: { trace: "retain-on-failure" }
})
