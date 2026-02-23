#!/usr/bin/env tsx
/**
 * Fleet Service Manager
 *
 * Manages the fleet server as a PM2 process with Doppler env injection.
 *
 * Usage:
 *   fleet-service start   — Start the fleet server (PM2 daemon)
 *   fleet-service stop    — Stop the fleet server
 *   fleet-service restart — Restart the fleet server
 *   fleet-service status  — Show server status + health check
 *   fleet-service logs    — Tail server logs
 *   fleet-service health  — Hit the /health endpoint
 */

import { execSync, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FLEET_ROOT = resolve(__dirname, "../../../..");
const PM2_NAME = "fleet-server";
const SERVER_PORT = process.env.PORT ?? "4020";

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: FLEET_ROOT,
      encoding: "utf-8",
      stdio: opts?.silent ? "pipe" : "inherit",
    });
  } catch (err: any) {
    if (opts?.silent) return err.stdout ?? "";
    throw err;
  }
}

function runSilent(cmd: string): string {
  return run(cmd, { silent: true });
}

function isRunning(): boolean {
  const out = runSilent(`pm2 jlist 2>/dev/null`);
  try {
    const list = JSON.parse(out);
    return list.some((p: any) => p.name === PM2_NAME && p.pm2_env?.status === "online");
  } catch {
    return false;
  }
}

function getProcessInfo(): any | null {
  const out = runSilent(`pm2 jlist 2>/dev/null`);
  try {
    const list = JSON.parse(out);
    return list.find((p: any) => p.name === PM2_NAME) ?? null;
  } catch {
    return null;
  }
}

async function healthCheck(): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function cmdStart() {
  if (isRunning()) {
    console.log(`✅ ${PM2_NAME} is already running.`);
    const h = await healthCheck();
    if (h.ok) {
      console.log(`Health: OK — ${JSON.stringify(h.data)}`);
    } else {
      console.log(`⚠️  Running but health check failed: ${h.error}`);
    }
    return;
  }

  console.log(`Starting ${PM2_NAME} via PM2 + Doppler...`);

  // Use doppler to inject env, then start via pm2
  run(
    `doppler run --project openclaw --config dev -- ` +
    `pm2 start ecosystem.config.cjs --env production`,
  );

  // Wait a moment for startup
  await new Promise((r) => setTimeout(r, 3000));

  if (isRunning()) {
    console.log(`✅ ${PM2_NAME} started.`);
    const h = await healthCheck();
    if (h.ok) {
      console.log(`Health: OK`);
    } else {
      console.log(`⚠️  Started but health check pending: ${h.error}`);
    }
  } else {
    console.error(`❌ Failed to start. Check logs: fleet-service logs`);
  }
}

function cmdStop() {
  if (!isRunning()) {
    console.log(`${PM2_NAME} is not running.`);
    return;
  }
  run(`pm2 stop ${PM2_NAME}`);
  console.log(`✅ ${PM2_NAME} stopped.`);
}

function cmdRestart() {
  if (!isRunning()) {
    console.log(`${PM2_NAME} is not running. Starting...`);
    cmdStart();
    return;
  }
  run(`pm2 restart ${PM2_NAME}`);
  console.log(`✅ ${PM2_NAME} restarted.`);
}

async function cmdStatus() {
  const info = getProcessInfo();
  if (!info) {
    console.log(`${PM2_NAME}: not registered with PM2`);
    return;
  }

  const status = info.pm2_env?.status ?? "unknown";
  const uptime = info.pm2_env?.pm_uptime
    ? `${Math.floor((Date.now() - info.pm2_env.pm_uptime) / 1000)}s`
    : "n/a";
  const restarts = info.pm2_env?.restart_time ?? 0;
  const memory = info.monit?.memory
    ? `${Math.round(info.monit.memory / 1024 / 1024)}MB`
    : "n/a";
  const cpu = info.monit?.cpu ?? "n/a";

  console.log(`=== ${PM2_NAME} ===`);
  console.log(`Status:   ${status}`);
  console.log(`Uptime:   ${uptime}`);
  console.log(`Restarts: ${restarts}`);
  console.log(`Memory:   ${memory}`);
  console.log(`CPU:      ${cpu}%`);

  if (status === "online") {
    const h = await healthCheck();
    if (h.ok) {
      console.log(`\nHealth: ✅ OK`);
      if (h.data) {
        console.log(`  Port:    ${SERVER_PORT}`);
        if (h.data.uptime) console.log(`  Uptime:  ${h.data.uptime}`);
        if (h.data.masterBalance) console.log(`  Master:  ${h.data.masterBalance} ETH`);
      }
    } else {
      console.log(`\nHealth: ❌ ${h.error}`);
    }
  }
}

function cmdLogs() {
  // Spawn pm2 logs in foreground so user can ctrl-c
  const child = spawn("pm2", ["logs", PM2_NAME, "--lines", "50"], {
    cwd: FLEET_ROOT,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function cmdHealth() {
  const h = await healthCheck();
  if (h.ok) {
    console.log("✅ Health OK");
    console.log(JSON.stringify(h.data, null, 2));
  } else {
    console.log(`❌ Health check failed: ${h.error}`);
    process.exit(1);
  }
}

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case "start":
      await cmdStart();
      break;
    case "stop":
      cmdStop();
      break;
    case "restart":
      await cmdRestart();
      break;
    case "status":
      await cmdStatus();
      break;
    case "logs":
      cmdLogs();
      break;
    case "health":
      await cmdHealth();
      break;
    default:
      console.log(`Fleet Service Manager

Commands:
  start    — Start the fleet server (PM2 + Doppler)
  stop     — Stop the fleet server
  restart  — Restart the fleet server
  status   — Show server status + health check
  logs     — Tail server logs
  health   — Hit the /health endpoint`);
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
