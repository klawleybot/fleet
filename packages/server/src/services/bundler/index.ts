import { getBundlerChainId, loadBundlerConfigFromEnv } from "./config.js";
import { HttpBundlerAdapter } from "./httpAdapter.js";
import { BundlerRouter } from "./router.js";

let singleton: BundlerRouter | null = null;

export function getBundlerRouter(): BundlerRouter {
  if (singleton) return singleton;

  const cfg = loadBundlerConfigFromEnv();
  const chainId = getBundlerChainId();

  const primary = new HttpBundlerAdapter({
    name: cfg.primary.name,
    rpcUrl: cfg.primary.rpcUrl,
    chainId,
    entryPoint: cfg.primary.entryPoint,
    timeoutMs: cfg.router.sendTimeoutMs,
  });

  const secondary = cfg.secondary
    ? new HttpBundlerAdapter({
        name: cfg.secondary.name,
        rpcUrl: cfg.secondary.rpcUrl,
        chainId,
        entryPoint: cfg.secondary.entryPoint,
        timeoutMs: cfg.router.sendTimeoutMs,
      })
    : null;

  singleton = new BundlerRouter(primary, secondary, cfg.router);
  return singleton;
}

export { classifyBundlerError, isFailoverWorthy } from "./errors.js";
export type {
  BundlerAdapter,
  BundlerErrorCategory,
  BundlerRouterConfig,
  BundlerRouterSendResult,
  Hex,
  SendUserOperationResult,
  UserOperationGasEstimate,
  UserOperationLike,
  UserOperationReceipt,
} from "./types.js";
