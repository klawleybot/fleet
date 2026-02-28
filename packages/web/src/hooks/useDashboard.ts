import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGlobalDashboard } from "../api/client";
import type { GlobalDashboard } from "../types";

const POLL_INTERVAL_MS = 30_000;

export function useDashboard() {
  const [dashboard, setDashboard] = useState<GlobalDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchGlobalDashboard();
      setDashboard(data);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
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

  return { dashboard, isLoading, error, lastUpdated, refresh: load };
}
