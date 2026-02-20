import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { autonomyRouter } from "./routes/autonomy.js";
import { clustersRouter } from "./routes/clusters.js";
import { fundingRouter } from "./routes/funding.js";
import { operationsRouter } from "./routes/operations.js";
import { positionsRouter } from "./routes/positions.js";
import { tradesRouter } from "./routes/trades.js";
import { walletsRouter } from "./routes/wallets.js";
import { getAutonomyConfig, startAutonomyLoop } from "./services/autonomy.js";
import { ensureMasterWallet } from "./services/wallet.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/wallets", walletsRouter);
app.use("/funding", fundingRouter);
app.use("/trades", tradesRouter);
app.use("/clusters", clustersRouter);
app.use("/operations", operationsRouter);
app.use("/positions", positionsRouter);
app.use("/autonomy", autonomyRouter);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unhandled server error";
  res.status(500).json({ error: message });
});

const port = Number.parseInt(process.env.PORT ?? "4020", 10);

async function start(): Promise<void> {
  try {
    await ensureMasterWallet();
    app.listen(port, () => {
      console.log(`pump-it-up server listening on http://localhost:${port}`);
      const autonomyCfg = getAutonomyConfig();
      if (autonomyCfg.enabled && autonomyCfg.autoStart) {
        try {
          const status = startAutonomyLoop({ intervalSec: autonomyCfg.intervalSec });
          console.log(`autonomy loop started interval=${status.intervalSec}s`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed to start autonomy loop";
          console.error(`autonomy startup skipped: ${message}`);
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start";
    console.error(message);
    process.exit(1);
  }
}

void start();

