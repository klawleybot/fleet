import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchIntelligenceSummary,
  startIntelligence,
  stopIntelligence,
  runIntelligenceTick,
} from "../api/client";
import type { IntelligenceSummary } from "../types";

const POLL_INTERVAL_MS = 10_000;

export function useIntelligence() {
  const [summary, setSummary] = useState<IntelligenceSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchIntelligenceSummary();
      setSummary(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load intelligence status");
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
      await startIntelligence(intervalSec);
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start intelligence");
    } finally {
      setIsBusy(false);
    }
  }, [load]);

  const stop = useCallback(async () => {
    setIsBusy(true);
    try {
      await stopIntelligence();
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop intelligence");
    } finally {
      setIsBusy(false);
    }
  }, [load]);

  const tick = useCallback(async () => {
    setIsBusy(true);
    try {
      await runIntelligenceTick();
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tick failed");
    } finally {
      setIsBusy(false);
    }
  }, [load]);

  return { summary, isLoading, isBusy, error, start, stop, tick, refresh: load };
}
