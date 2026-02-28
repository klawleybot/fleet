import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWatchlist, addToIntelWatchlist, removeFromIntelWatchlist } from "../api/client";
import type { WatchlistItem } from "../types";

const POLL_INTERVAL_MS = 20_000;

export function useWatchlist(listName = "default") {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchWatchlist(listName);
      setItems(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load watchlist");
    } finally {
      setIsLoading(false);
    }
  }, [listName]);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  const addCoin = useCallback(async (coinAddress: string, label?: string) => {
    setIsBusy(true);
    try {
      await addToIntelWatchlist(coinAddress, listName, label);
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add coin");
    } finally {
      setIsBusy(false);
    }
  }, [listName, load]);

  const removeCoin = useCallback(async (coinAddress: string) => {
    setIsBusy(true);
    try {
      await removeFromIntelWatchlist(coinAddress, listName);
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove coin");
    } finally {
      setIsBusy(false);
    }
  }, [listName, load]);

  return { items, isLoading, isBusy, error, addCoin, removeCoin, refresh: load };
}
