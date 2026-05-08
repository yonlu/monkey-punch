import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAvailableRooms,
  type AvailableRoom,
} from "../net/matchmake.js";

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  "ws://localhost:2567";

const DEFAULT_INTERVAL_MS = 3000;

export type UseAvailableRoomsResult = {
  rooms: AvailableRoom[];
  loading: boolean; // true only on initial mount before first poll resolves
  error: Error | null; // most recent poll error; null after a success
  refresh: () => void; // forces an immediate re-poll
};

export function useAvailableRooms(
  intervalMs = DEFAULT_INTERVAL_MS,
): UseAvailableRoomsResult {
  const [rooms, setRooms] = useState<AvailableRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Used by refresh() and by the interval. Captures the latest setters.
  const cancelledRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const next = await fetchAvailableRooms(SERVER_URL);
      if (cancelledRef.current) return;
      setRooms(next);
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // Intentionally do NOT clear `rooms` — keep the last successful list
      // visible across transient errors.
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [poll, intervalMs]);

  return { rooms, loading, error, refresh: poll };
}
