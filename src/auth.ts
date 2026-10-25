import type { Env } from "./types";

/**
 * Identifica al usuario a partir del JWT de Cloudflare Access.
 * Falla cerrado: si Access no está configurado y no estamos en DEV_MODE, nadie entra.
 */
export async function getUser(req: Request, env: Env): Promise<string | null> {
  if (env.DEV_MODE === "true") return env.DEV_USER || "dev@local";

  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const payload = await verifyAccessJwt(token, env);
  if (!payload) return null;

  const email = String(payload.email || "").toLowerCase();
  return allowedSenders(env).includes(email) ? email : null;
}

export function allowedSenders(env: Env): string[] {
  return env.ALLOWED_SENDERS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// --- Verificación RS256 con las claves públicas de Access ---

let jwksCache: { keys: JsonWebKey[]; at: number } | null = null;

async function getKeys(env: Env): Promise<(JsonWebKey & { kid?: string })[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  const data = (await res.json()) as { keys: JsonWebKey[] };
  jwksCache = { keys: data.keys, at: Date.now() };
  return data.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function verifyAccessJwt(token: string, env: Env): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

  const jwk = (await getKeys(env)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null;
  return payload;
}
