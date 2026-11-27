export function prefixUpperBound(prefix: string): string | null {
  const chars = [...prefix];
  while (chars.length) {
    const last = chars.pop()!;
    const codepoint = last.codePointAt(0)!;
    if (codepoint < 0x10ffff) return chars.join("") + String.fromCodePoint(codepoint + 1);
  }
  return null;
}

export function listQuery(prefix: string): { sql: string; params: string[] } {
  if (!prefix) {
    return {
      sql: "SELECT key,value FROM kv ORDER BY key LIMIT 1000",
      params: [],
    };
  }
  const end = prefixUpperBound(prefix);
  if (end === null) {
    return {
      sql: "SELECT key,value FROM kv WHERE key>=? ORDER BY key LIMIT 1000",
      params: [prefix],
    };
  }
  return {
    sql: "SELECT key,value FROM kv WHERE key>=? AND key<? ORDER BY key LIMIT 1000",
    params: [prefix, end],
  };
}
