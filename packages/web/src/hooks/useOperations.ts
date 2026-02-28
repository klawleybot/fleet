import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOperations } from "../api/client";
import type { OperationRecord } from "../types";

const POLL_INTERVAL_MS = 15_000;

export function useOperations(limit = 50) {
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchOperations(limit);
      setOperations(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load operations");
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

  return { operations, isLoading, error, refresh: load };
}
