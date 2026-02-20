module.exports = {
  apps: [{
    name: "fleet-server",
    script: "npx",
    args: "tsx packages/server/src/index.ts",
    cwd: "/Users/user/.openclaw/workspace/fleet",
    log_file: "/Users/user/.openclaw/workspace/fleet/logs/fleet.log",
    error_file: "/Users/user/.openclaw/workspace/fleet/logs/fleet-error.log",
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
    },
  }],
};
