import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { fundingRouter } from "./routes/funding.js";
import { tradesRouter } from "./routes/trades.js";
import { walletsRouter } from "./routes/wallets.js";
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start";
    console.error(message);
    process.exit(1);
  }
}

void start();

