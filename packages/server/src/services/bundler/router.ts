import { isFailoverWorthy } from "./errors.js";
import type {
  BundlerAdapter,
  BundlerRouterConfig,
  BundlerRouterSendResult,
  Hex,
  SendUserOperationResult,
  UserOperationLike,
  UserOperationReceipt,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BundlerRouter {
  constructor(
    private readonly primary: BundlerAdapter,
    private readonly secondary: BundlerAdapter | null,
    private readonly cfg: BundlerRouterConfig,
  ) {}

  async send(userOp: UserOperationLike): Promise<BundlerRouterSendResult> {
    const attempts: BundlerRouterSendResult["attempts"] = [];

    try {
      const primaryResult = await withTimeout(
        this.primary.sendUserOperation(userOp),
        this.cfg.sendTimeoutMs,
        `${this.primary.name}.sendUserOperation`,
      );
      attempts.push({ provider: this.primary.name, ok: true });
      return { primary: this.primary.name, attempts, selected: primaryResult };
    } catch (error) {
      attempts.push({
        provider: this.primary.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!this.secondary || !isFailoverWorthy(error)) {
        throw error;
      }
    }

    const secondaryResult = await withTimeout(
      this.secondary!.sendUserOperation(userOp),
      this.cfg.sendTimeoutMs,
      `${this.secondary!.name}.sendUserOperation`,
    );
    attempts.push({ provider: this.secondary!.name, ok: true });
    return {
      primary: this.primary.name,
      attempts,
      selected: secondaryResult,
    };
  }

  async sendHedged(userOp: UserOperationLike): Promise<BundlerRouterSendResult> {
    if (!this.secondary) {
      return this.send(userOp);
    }

    const attempts: BundlerRouterSendResult["attempts"] = [];

    const primaryPromise = withTimeout(
      this.primary.sendUserOperation(userOp),
      this.cfg.sendTimeoutMs,
      `${this.primary.name}.sendUserOperation`,
    )
      .then((result) => {
        attempts.push({ provider: this.primary.name, ok: true });
        return result;
      })
      .catch((error) => {
        attempts.push({
          provider: this.primary.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });

    const secondaryPromise = (async () => {
      await sleep(this.cfg.hedgeDelayMs);
      return withTimeout(
        this.secondary!.sendUserOperation(userOp),
        this.cfg.sendTimeoutMs,
        `${this.secondary!.name}.sendUserOperation`,
      );
    })()
      .then((result) => {
        attempts.push({ provider: this.secondary!.name, ok: true });
        return result;
      })
      .catch((error) => {
        attempts.push({
          provider: this.secondary!.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });

    let selected: SendUserOperationResult;
    try {
      selected = await Promise.any([primaryPromise, secondaryPromise]);
    } catch {
      const errorSummary = attempts.map((a) => `${a.provider}:${a.error ?? "unknown"}`).join(" | ");
      throw new Error(`All bundler send attempts failed: ${errorSummary}`);
    }

    return {
      primary: this.primary.name,
      attempts,
      selected,
    };
  }

  async waitForReceipt(userOpHash: Hex): Promise<UserOperationReceipt> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.cfg.receiptTimeoutMs) {
      const [primaryReceipt, secondaryReceipt] = await Promise.all([
        this.primary.getUserOperationReceipt(userOpHash),
        this.secondary ? this.secondary.getUserOperationReceipt(userOpHash) : Promise.resolve(null),
      ]);

      if (primaryReceipt.included) return primaryReceipt;
      if (secondaryReceipt?.included) return secondaryReceipt;

      await sleep(this.cfg.receiptPollMs);
    }

    return { included: false, reason: `receipt timeout after ${this.cfg.receiptTimeoutMs}ms` };
  }
}
