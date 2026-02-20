import "dotenv/config";

import { logger } from "./logger.js";

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandledRejection");
});
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import PinoHttpModule from "pino-http";
const pinoHttp = PinoHttpModule.default ?? PinoHttpModule;
import { formatEther } from "viem";
import { autonomyRouter } from "./routes/autonomy.js";
import { clustersRouter } from "./routes/clusters.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { fleetsRouter } from "./routes/fleets.js";
import { fundingRouter } from "./routes/funding.js";
import { operationsRouter } from "./routes/operations.js";
import { positionsRouter } from "./routes/positions.js";
import { tradesRouter } from "./routes/trades.js";
import { walletsRouter } from "./routes/wallets.js";
import { getAutonomyConfig, startAutonomyLoop } from "./services/autonomy.js";
import { getEthBalance } from "./services/balance.js";
import { ensureMasterWallet } from "./services/wallet.js";
import { db } from "./db/index.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));

const startedAt = new Date().toISOString();
let cachedMasterBalanceEth: string | null = null;
let balanceCacheTime = 0;

async function refreshMasterBalance(): Promise<string> {
  const now = Date.now();
  if (cachedMasterBalanceEth && now - balanceCacheTime < 60_000) {
    return cachedMasterBalanceEth;
  }
  try {
    const wallets = db.listWallets();
    const master = wallets.find((w) => w.isMaster);
    if (master) {
      const bal = await getEthBalance(master.address);
      cachedMasterBalanceEth = formatEther(bal);
    } else {
      cachedMasterBalanceEth = "0";
    }
  } catch {
    cachedMasterBalanceEth = cachedMasterBalanceEth ?? "unknown";
  }
  balanceCacheTime = now;
  return cachedMasterBalanceEth;
}

app.get("/health", async (_req, res) => {
  try {
    const trades = db.listTrades();
    const allWallets = db.listWallets();
    const activeFleetCount = allWallets.filter((w) => !w.isMaster).length;
    const masterBalanceEth = await refreshMasterBalance();

    res.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      startedAt,
      lastTradeAt: trades.length > 0 ? trades[0]!.createdAt : null,
      activeFleetCount,
      masterBalanceEth,
    });
  } catch {
    res.json({ ok: true, uptimeSec: Math.floor(process.uptime()), startedAt });
  }
});

app.use("/wallets", walletsRouter);
app.use("/funding", fundingRouter);
app.use("/trades", tradesRouter);
app.use("/clusters", clustersRouter);
app.use("/fleets", fleetsRouter);
app.use("/operations", operationsRouter);
app.use("/positions", positionsRouter);
app.use("/dashboard", dashboardRouter);
app.use("/autonomy", autonomyRouter);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unhandled server error";
  logger.error({ err: error }, message);
  res.status(500).json({ error: message });
});

const port = Number.parseInt(process.env.PORT ?? "4020", 10);

async function start(): Promise<void> {
  try {
    // Log environment context
    const dopplerConfig = process.env.DOPPLER_CONFIG ?? "unknown";
    const network = process.env.APP_NETWORK ?? "unknown";
    const mockMode = process.env.CDP_MOCK_MODE === "1";

    if (dopplerConfig === "prd" || dopplerConfig.startsWith("prd_")) {
      if (mockMode) {
        logger.fatal("Refusing to start: CDP_MOCK_MODE=1 with production config");
        process.exit(1);
      }
      logger.warn("⚠️  PRODUCTION MODE — using live keys and real funds");
    }

    logger.info({ dopplerConfig, network, mockMode }, "fleet server starting");

    await ensureMasterWallet();
    app.listen(port, () => {
      logger.info({ port }, "pump-it-up server listening");
      const autonomyCfg = getAutonomyConfig();
      if (autonomyCfg.enabled && autonomyCfg.autoStart) {
        try {
          const status = startAutonomyLoop({ intervalSec: autonomyCfg.intervalSec });
          logger.info({ intervalSec: status.intervalSec }, "autonomy loop started");
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed to start autonomy loop";
          logger.error({ err: error }, `autonomy startup skipped: ${message}`);
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start";
    logger.fatal({ err: error }, message);
    process.exit(1);
  }
}

void start();

