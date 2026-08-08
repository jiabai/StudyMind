type Reply = { header(name: string, value: string | string[]): unknown; getHeader(name: string): unknown };
export function setCookie(reply: Reply, name: string, value: string, options: { httpOnly: boolean; maxAgeSeconds: number; secure: boolean }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${Math.floor(options.maxAgeSeconds)}`, "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly"); if (options.secure) parts.push("Secure");
  const current = reply.getHeader("set-cookie"); const next = Array.isArray(current) ? current.map(String) : current ? [String(current)] : [];
  reply.header("set-cookie", [...next, parts.join("; ")]);
}
export function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of header?.split(";") ?? []) {
    const [name, ...value] = entry.trim().split("=");
    if (!name || value.length === 0) continue;
    try { result.set(name, decodeURIComponent(value.join("="))); } catch { /* ignore malformed cookie */ }
  }
  return result;
}
