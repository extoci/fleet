import { useEffect, useState, useCallback } from "preact/hooks";

export async function call(kind, name, input = null, { keepalive } = {}) {
  const response = await fetch(
    `/__fleet/api/${kind}/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      keepalive,
    },
  );
  if (response.status === 401) {
    location.reload();
    throw new Error("Connect this browser through Fleet Gate.");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The app request failed.");
  return result.value;
}
const listeners = new Set();
export function useQuery(name, input = null, { pollMs = 10_000 } = {}) {
  const [state, setState] = useState({ data: undefined, error: null });
  const encoded = JSON.stringify(input);
  useEffect(() => {
    let active = true;
    let requested = 0;
    let settled = 0;
    const refresh = () => {
      const request = ++requested;
      return call("queries", name, JSON.parse(encoded))
        .then((data) => {
          if (!active || request < settled) return;
          settled = request;
          setState({ data, error: null });
        })
        .catch((error) => {
          if (!active || request < settled) return;
          settled = request;
          setState((s) => ({ ...s, error }));
        });
    };
    const listener = { name, refresh };
    listeners.add(listener);
    refresh();
    const timer =
      pollMs > 0
        ? setInterval(() => {
            if (document.visibilityState === "visible") refresh();
          }, pollMs)
        : undefined;
    return () => {
      active = false;
      clearInterval(timer);
      listeners.delete(listener);
    };
  }, [name, encoded, pollMs]);
  return state;
}
export function useMutation(name, { invalidate } = {}) {
  const names = JSON.stringify(invalidate);
  return useCallback(
    async (input) => {
      const result = await call("mutations", name, input);
      const selected = names === undefined ? undefined : JSON.parse(names);
      if (selected === false) return result;
      for (const listener of listeners)
        if (!selected || selected.includes(listener.name)) listener.refresh();
      return result;
    },
    [name, names],
  );
}
