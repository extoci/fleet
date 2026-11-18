import { useEffect, useState, useCallback } from "preact/hooks";

export async function call(kind, name, input = null) {
  const response = await fetch(
    `/__fleet/api/${kind}/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
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
export function useQuery(name, input = null) {
  const [state, setState] = useState({ data: undefined, error: null });
  const encoded = JSON.stringify(input);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      call("queries", name, JSON.parse(encoded))
        .then((data) => {
          if (active) setState({ data, error: null });
        })
        .catch((error) => {
          if (active) setState((s) => ({ ...s, error }));
        });
    listeners.add(refresh);
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
      listeners.delete(refresh);
    };
  }, [name, encoded]);
  return state;
}
export function useMutation(name) {
  return useCallback(
    async (input) => {
      const result = await call("mutations", name, input);
      for (const refresh of listeners) refresh();
      return result;
    },
    [name],
  );
}
