const path = require("node:path");

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, "logs");

module.exports = {
  apps: [{
    name: "fleet-server",
    script: "bun",
    args: "x tsx packages/server/src/index.ts",
    cwd: ROOT,
    log_file: path.join(LOG_DIR, "fleet.log"),
    error_file: path.join(LOG_DIR, "fleet-error.log"),
    time: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    kill_timeout: 5000,
    env: {
      NODE_ENV: "production",
      SIGNER_BACKEND: "local",
      CDP_MOCK_MODE: "0",
      APP_NETWORK: "base",
      PORT: "4020",
      FLEET_KILL_SWITCH: "false",
      INTELLIGENCE_ENABLED: "true",
      INTELLIGENCE_INTERVAL_SEC: "60",
    },
  }],
};
