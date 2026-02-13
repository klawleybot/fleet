import { useCallback, useEffect, useState } from "react";
import { executeSwap, fetchFundingHistory, fetchTradeHistory } from "../api/client";
import type { FundingRecord, TradeRecord } from "../types";

export interface UseTradesResult {
  tradeHistory: TradeRecord[];
  fundingHistory: FundingRecord[];
  isSubmitting: boolean;
  error: string | null;
  refreshHistory: () => Promise<void>;
  runSwap: (input: {
    walletIds: number[];
    fromToken: `0x${string}`;
    toToken: `0x${string}`;
    amountInWei: string;
    slippageBps: number;
  }) => Promise<void>;
}

export function useTrades(): UseTradesResult {
  const [tradeHistory, setTradeHistory] = useState<TradeRecord[]>([]);
  const [fundingHistory, setFundingHistory] = useState<FundingRecord[]>([]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      const [trades, funding] = await Promise.all([
        fetchTradeHistory(),
        fetchFundingHistory(),
      ]);
      setTradeHistory(trades);
      setFundingHistory(funding);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : "Failed to fetch history";
      setError(message);
    }
  }, []);

  const runSwap = useCallback(
    async (input: {
      walletIds: number[];
      fromToken: `0x${string}`;
      toToken: `0x${string}`;
      amountInWei: string;
      slippageBps: number;
    }) => {
      setIsSubmitting(true);
      setError(null);
      try {
        await executeSwap(input);
        await refreshHistory();
      } catch (requestError) {
        const message =
          requestError instanceof Error ? requestError.message : "Swap execution failed";
        setError(message);
      } finally {
        setIsSubmitting(false);
      }
    },
    [refreshHistory],
  );

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  return {
    tradeHistory,
    fundingHistory,
    isSubmitting,
    error,
    refreshHistory,
    runSwap,
  };
}

