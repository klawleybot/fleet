import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import * as protocolDeployments from "@zoralabs/protocol-deployments";
import { env } from "./config.js";
import {
  dispatchPendingAlerts,
  dispatchPendingAlertsRich,
  firstKnownCoin,
  latestAlerts,
  pollOnce,
  recentCoins,
  runPollingLoop,
  syncRecentCoins,
  syncTopVolumeCoins,
  topAnalytics,
  topVolumeCoins,
  watchlistAddCoin,
  watchlistList,
  watchlistRecentMoves,
  watchlistRemoveCoin,
} from "./zora.js";

function ensurePath(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isPidRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonStart() {
  ensurePath(env.PID_PATH);
  ensurePath(env.DAEMON_LOG_PATH);

  if (fs.existsSync(env.PID_PATH)) {
    const existingPid = Number(fs.readFileSync(env.PID_PATH, "utf8").trim());
    if (existingPid && isPidRunning(existingPid)) {
      console.log(`Daemon already running (pid=${existingPid})`);
      return;
    }
    fs.rmSync(env.PID_PATH, { force: true });
  }

  const pid = execSync(`nohup npm run daemon:run >> ${env.DAEMON_LOG_PATH} 2>&1 & echo $!`, {
    encoding: "utf8",
  }).trim();

  fs.writeFileSync(env.PID_PATH, `${pid}\n`, "utf8");
  console.log(`Daemon started pid=${pid}`);
}

function daemonStop() {
  if (!fs.existsSync(env.PID_PATH)) {
    console.log("Daemon not running (no pid file)");
    return;
  }
  const pid = Number(fs.readFileSync(env.PID_PATH, "utf8").trim());
  if (!pid) {
    fs.rmSync(env.PID_PATH, { force: true });
    console.log("Daemon pid invalid; cleaned pid file");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to pid=${pid}`);
  } catch {
    console.log(`Process ${pid} not running`);
  }
  fs.rmSync(env.PID_PATH, { force: true });
}

function daemonStatus() {
  if (!fs.existsSync(env.PID_PATH)) {
    console.log("stopped (no pid file)");
    return;
  }
  const pid = Number(fs.readFileSync(env.PID_PATH, "utf8").trim());
  const running = pid && isPidRunning(pid);
  console.log(running ? `running pid=${pid}` : `stale pid=${pid} (not running)`);
  if (fs.existsSync(env.DAEMON_LOG_PATH)) {
    const tail = execSync(`tail -n 8 ${env.DAEMON_LOG_PATH}`, { encoding: "utf8" });
    console.log("--- daemon log tail ---");
    console.log(tail);
  }
}

async function main() {
  const cmd = process.argv[2];

  if (!cmd || cmd === "help") {
    console.log(`zora-intelligence commands:\n\n  sync [count]                       Sync recent + top-volume coins\n  poll-once                          Ingest swaps + analytics + alerts once\n  daemon:start                       Start background polling daemon (nohup + pid file)\n  daemon:stop                        Stop daemon\n  daemon:status                      Show daemon status + log tail\n  daemon:run                         Run polling loop in foreground\n  recent [limit]                     Show recent coins\n  top-volume [limit]                 Show top volume (24h)\n  analytics [limit]                  Show top coin analytics\n  alerts [limit]                     Show recent alerts\n  dispatch-alerts                    Print + mark unsent alerts (text only)\n  dispatch-alerts-rich               Print JSON payload + media files for relay\n  watchlist:add <addr> [list] [lbl]  Add coin to watchlist\n  watchlist:remove <addr> [list]     Remove coin from watchlist\n  watchlist:list [list]              Show watchlist with analytics\n  watchlist:moves [list] [limit]     Show recent moves for watched coins\n  first-coin                         Show first known coin in local index\n  contracts                          Show Zora coin factory addresses\n`);
    return;
  }

  if (cmd === "contracts") {
    console.log("Zora Coin Factory addresses from @zoralabs/protocol-deployments:");
    console.log(JSON.stringify((protocolDeployments as any).coinFactoryAddress ?? {}, null, 2));
    return;
  }

  if (cmd === "sync") {
    const count = Number(process.argv[3] ?? 150);
    const a = await syncRecentCoins(count);
    const b = await syncTopVolumeCoins(count);
    console.log(`Synced: ${a} recent + ${b} top-volume coins into ${env.DB_PATH}`);
    return;
  }

  if (cmd === "poll-once") {
    console.log(await pollOnce());
    return;
  }

  if (cmd === "daemon:start") {
    console.log("NOTE: Standalone daemon is deprecated. Use the server's /intelligence/start endpoint or set INTELLIGENCE_ENABLED=true.");
    return daemonStart();
  }
  if (cmd === "daemon:stop") {
    console.log("NOTE: Standalone daemon is deprecated. Use the server's /intelligence/stop endpoint.");
    return daemonStop();
  }
  if (cmd === "daemon:status") {
    console.log("NOTE: Standalone daemon is deprecated. Use GET /intelligence/status on the server.");
    return daemonStatus();
  }
  if (cmd === "daemon:run") {
    console.log("NOTE: Standalone daemon is deprecated. Use INTELLIGENCE_ENABLED=true with the server.");
    return runPollingLoop();
  }

  if (cmd === "recent") {
    console.table(recentCoins(Number(process.argv[3] ?? 20)));
    return;
  }

  if (cmd === "top-volume") {
    console.table(topVolumeCoins(Number(process.argv[3] ?? 20)));
    return;
  }

  if (cmd === "analytics") {
    console.table(topAnalytics(Number(process.argv[3] ?? 20)));
    return;
  }

  if (cmd === "alerts") {
    console.table(latestAlerts(Number(process.argv[3] ?? 20)));
    return;
  }

  if (cmd === "dispatch-alerts") {
    const msg = await dispatchPendingAlerts(Number(process.argv[3] ?? 12));
    if (!msg) {
      console.log("NO_ALERTS");
      return;
    }
    console.log(msg);
    return;
  }

  if (cmd === "dispatch-alerts-rich") {
    const payload = await dispatchPendingAlertsRich(Number(process.argv[3] ?? 12));
    if (!payload) {
      console.log("NO_ALERTS");
      return;
    }
    console.log(JSON.stringify(payload));
    return;
  }

  if (cmd === "watchlist:add") {
    const addr = process.argv[3];
    const list = process.argv[4] ?? "default";
    const label = process.argv.slice(5).join(" ") || undefined;
    if (!addr) throw new Error("Usage: watchlist:add <coin_address> [list_name] [label]");
    console.log(watchlistAddCoin(addr, list, label));
    return;
  }

  if (cmd === "watchlist:remove") {
    const addr = process.argv[3];
    const list = process.argv[4] ?? "default";
    if (!addr) throw new Error("Usage: watchlist:remove <coin_address> [list_name]");
    console.log({ removed: watchlistRemoveCoin(addr, list) });
    return;
  }

  if (cmd === "watchlist:list") {
    const list = process.argv[3] ?? "default";
    console.table(watchlistList(list));
    return;
  }

  if (cmd === "watchlist:moves") {
    const list = process.argv[3] ?? "default";
    const limit = Number(process.argv[4] ?? 25);
    console.table(watchlistRecentMoves(list, limit));
    return;
  }

  if (cmd === "first-coin") {
    const row = firstKnownCoin();
    if (!row) {
      console.log("No local data yet. Run: npm run sync");
      return;
    }
    console.table([row]);
    console.log("Note: this is the first coin in your local indexed dataset.");
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
