import { useCallback, useEffect, useState } from "preact/hooks";

export async function call<T = unknown>(
  kind: "queries" | "mutations",
  name: string,
  input: unknown = null,
  { keepalive }: { keepalive?: boolean } = {},
): Promise<T> {
  const response = await fetch(`/__fleet/api/${kind}/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    keepalive,
  });
  if (response.status === 401) {
    location.reload();
    throw new Error("Connect this browser through Fleet Gate.");
  }
  const result = (await response.json()) as { value?: T; error?: string };
  if (!response.ok) throw new Error(result.error || "The app request failed.");
  return result.value as T;
}

const listeners = new Set<{ name: string; refresh: () => Promise<void> }>();

export function useQuery<T = unknown>(
  name: string,
  input: unknown = null,
  { pollMs = 10_000 }: { pollMs?: number | false } = {},
): { data: T | undefined; error: Error | null } {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null }>({
    data: undefined,
    error: null,
  });
  const encoded = JSON.stringify(input);
  useEffect(() => {
    let active = true;
    let requested = 0;
    let settled = 0;
    const refresh = () => {
      const request = ++requested;
      return call<T>("queries", name, JSON.parse(encoded))
        .then((data) => {
          if (!active || request < settled) return;
          settled = request;
          setState({ data, error: null });
        })
        .catch((error: unknown) => {
          if (!active || request < settled) return;
          settled = request;
          const err = error instanceof Error ? error : new Error(String(error));
          setState((s) => ({ ...s, error: err }));
        });
    };
    const listener = { name, refresh };
    listeners.add(listener);
    void refresh();
    const timer =
      pollMs && pollMs > 0
        ? setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
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

export function useMutation<T = unknown, Input = unknown>(
  name: string,
  { invalidate }: { invalidate?: string[] | false } = {},
): (input?: Input) => Promise<T> {
  const names = JSON.stringify(invalidate);
  return useCallback(
    async (input?: Input) => {
      const result = await call<T>("mutations", name, input);
      const selected = names === undefined ? undefined : (JSON.parse(names) as string[] | false);
      if (selected === false) return result;
      for (const listener of listeners) {
        if (!selected || selected.includes(listener.name)) void listener.refresh();
      }
      return result;
    },
    [name, names],
  );
}
