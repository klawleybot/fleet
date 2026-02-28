import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTopAnalytics } from "../api/client";
import type { IntelAnalytics } from "../types";

const POLL_INTERVAL_MS = 20_000;

export function useCoins(limit = 30) {
  const [coins, setCoins] = useState<IntelAnalytics[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchTopAnalytics(limit);
      setCoins(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load coins");
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  return { coins, isLoading, error, refresh: load };
}
