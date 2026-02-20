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
    env: {
      NODE_ENV: "production",
    },
  }],
};
