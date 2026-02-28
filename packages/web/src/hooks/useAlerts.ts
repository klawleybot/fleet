import { useCallback, useEffect, useRef, useState } from "react";
import { fetchIntelAlerts } from "../api/client";
import type { IntelAlert } from "../types";

const POLL_INTERVAL_MS = 15_000;

export function useAlerts(limit = 50) {
  const [alerts, setAlerts] = useState<IntelAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchIntelAlerts(limit);
      setAlerts(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
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

  return { alerts, isLoading, error, refresh: load };
}
