import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTradeHistory, fetchFundingHistory } from "../api/client";
import type { TradeRecord, FundingRecord } from "../types";

const POLL_INTERVAL_MS = 15_000;

export function useActivity() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [funding, setFunding] = useState<FundingRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([fetchTradeHistory(), fetchFundingHistory()]);
      setTrades(t);
      setFunding(f);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  return { trades, funding, isLoading, error, refresh: load };
}
