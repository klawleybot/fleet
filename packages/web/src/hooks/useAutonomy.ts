import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAutonomyStatus, startAutonomy, stopAutonomy, runAutonomyTick } from "../api/client";
import type { AutonomyStatus } from "../types";

const POLL_INTERVAL_MS = 10_000;

export function useAutonomy() {
  const [status, setStatus] = useState<AutonomyStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchAutonomyStatus();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load autonomy status");
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

  const start = useCallback(async (intervalSec?: number) => {
    setIsBusy(true);
    try {
      const data = await startAutonomy(intervalSec);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start autonomy");
    } finally {
      setIsBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setIsBusy(true);
    try {
      const data = await stopAutonomy();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop autonomy");
    } finally {
      setIsBusy(false);
    }
  }, []);

  const tick = useCallback(async () => {
    setIsBusy(true);
    try {
      await runAutonomyTick();
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tick failed");
    } finally {
      setIsBusy(false);
    }
  }, [load]);

  return { status, isLoading, isBusy, error, start, stop, tick, refresh: load };
}
