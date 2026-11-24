/**
 * DreaMedia Extension — Anime Utility
 * Pure utility functions for anime domain handling. No `any` type permitted.
 */

/**
 * Normalize a raw domain string to a hostname.
 */
export function normalizeDomain(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let d: string;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    d = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
  return d.startsWith("www.") ? d.slice(4) : d;
}

/**
 * Generate host match patterns for content-script registration.
 */
export function domainHostPatterns(raw: string): string[] {
  const host = normalizeDomain(raw);
  if (!host) return [];
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
  const matchHost = isIp || host === "localhost" ? host : `*.${host}`;
  return [`http://${matchHost}/*`, `https://${matchHost}/*`];
}

/**
 * Check if a URL matches a given domain.
 */
export function urlMatchesDomain(url: string, domain: string): boolean {
  const host = normalizeDomain(url);
  const allowed = normalizeDomain(domain);
  return Boolean(host && allowed && (host === allowed || host.endsWith(`.${allowed}`)));
}

/**
 * Check if a URL matches any enabled domain.
 */
export function urlMatchesEnabledDomains(
  url: string,
  domains: { domain: string; enabled?: boolean }[]
): boolean {
  return domains.some((row) => row?.enabled && urlMatchesDomain(url, row.domain));
}

/**
 * Build a lookup map keyed by lowercase domain.
 */
export function buildDomainLookup(
  domains: { domain: string; enabled?: boolean }[]
): Map<string, { domain: string; enabled?: boolean }> {
  const lookup = new Map<string, { domain: string; enabled?: boolean }>();
  for (const d of domains) {
    lookup.set(d.domain.toLowerCase(), d);
  }
  return lookup;
}

/**
 * Sleep helper for delays.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
