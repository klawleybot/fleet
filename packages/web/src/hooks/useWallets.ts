import { useCallback, useEffect, useMemo, useState } from "react";
import { createFleetWallets, fetchWallets } from "../api/client";
import type { Wallet } from "../types";

export interface UseWalletsResult {
  wallets: Wallet[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createFleet: (count: number) => Promise<void>;
  masterWallet: Wallet | null;
}

export function useWallets(): UseWalletsResult {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextWallets = await fetchWallets();
      setWallets(nextWallets);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : "Failed to load wallets";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createFleet = useCallback(
    async (count: number) => {
      setIsLoading(true);
      setError(null);
      try {
        await createFleetWallets(count);
        const nextWallets = await fetchWallets();
        setWallets(nextWallets);
      } catch (requestError) {
        const message =
          requestError instanceof Error ? requestError.message : "Failed to create wallets";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const masterWallet = useMemo(
    () => wallets.find((wallet) => wallet.isMaster) ?? null,
    [wallets],
  );

  return {
    wallets,
    isLoading,
    error,
    refresh,
    createFleet,
    masterWallet,
  };
}

