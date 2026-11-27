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
  const text = await response.text();
  let result: { value?: T; error?: string };
  try {
    result = JSON.parse(text) as { value?: T; error?: string };
  } catch {
    if (!response.ok) {
      const detail = text.trim().replace(/\s+/g, " ").slice(0, 200);
      throw new Error(detail || `The app request failed with status ${response.status}.`);
    }
    throw new Error("The app returned an invalid response.");
  }
  if (!response.ok) throw new Error(result.error || "The app request failed.");
  return result.value as T;
}

const listeners = new Set<{ name: string; refresh: () => Promise<void> }>();

function refreshQueries(): void {
  for (const listener of [...listeners]) void listener.refresh();
}

interface FleetPageState {
  revision?: string | null;
  events?: EventSource;
}

function fleetEvents(): EventSource {
  const target = window as Window & { __fleet?: FleetPageState };
  if (!target.__fleet?.events) {
    target.__fleet = {
      ...target.__fleet,
      events: new EventSource("/__fleet/events"),
    };
  }
  return target.__fleet.events!;
}

let wiredSource: EventSource | null = null;
let sourceWasOpen = false;
let visibilityWired = false;

function wireEvents(): void {
  const source = fleetEvents();
  if (!visibilityWired) {
    visibilityWired = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshQueries();
    });
  }
  if (wiredSource === source) return;
  wiredSource = source;
  sourceWasOpen = source.readyState === 1;
  source.addEventListener("open", () => {
    if (sourceWasOpen) refreshQueries();
    sourceWasOpen = true;
  });
  source.addEventListener("message", (event) => {
    try {
      const state = JSON.parse(event.data) as { type?: string };
      if (state.type === "data") refreshQueries();
    } catch {
      // Keepalive comments and malformed intermediary frames carry no data.
    }
  });
}

export function useQuery<T = unknown>(
  name: string,
  input: unknown = null,
  { pollMs = false }: { pollMs?: number | false } = {},
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
    wireEvents();
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
