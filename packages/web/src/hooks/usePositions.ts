import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAllPositions } from "../api/client";
import type { PositionRecord } from "../types";

const POLL_INTERVAL_MS = 20_000;

export function usePositions() {
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchAllPositions();
      setPositions(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load positions");
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

  return { positions, isLoading, error, refresh: load };
}
