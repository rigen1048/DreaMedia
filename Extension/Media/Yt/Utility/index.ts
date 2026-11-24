/**
 * DreaMedia Extension — YouTube Utility
 * Pure utility functions for YouTube domain/channel handling. No `any` type permitted.
 */

import type { Channel } from "../Config/Model/types";

/**
 * Normalize a raw domain string to a hostname (strip protocol, www prefix, trailing dot).
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
 * Check if a URL matches a given domain (exact or subdomain).
 */
export function urlMatchesDomain(url: string, domain: string): boolean {
  const host = normalizeDomain(url);
  const allowed = normalizeDomain(domain);
  return Boolean(host && allowed && (host === allowed || host.endsWith(`.${allowed}`)));
}

/**
 * Check if a URL matches any enabled domain in a list.
 */
export function urlMatchesEnabledDomains(
  url: string,
  domains: { domain: string; enabled?: boolean }[]
): boolean {
  return domains.some((row) => row?.enabled && urlMatchesDomain(url, row.domain));
}

/**
 * Extract a comparable channel key from a YouTube URL.
 * Handles /@handle, /channel/UC…, /c/name, /user/name.
 */
export function channelKey(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, "https://www.youtube.com");
    const m = u.pathname.match(/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/i);
    return m ? (m[1] ?? "").toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Convert a Channel array into a lookup map keyed by lowercase channel key.
 */
export function buildChannelLookup(channels: Channel[]): Map<string, Channel> {
  const lookup = new Map<string, Channel>();
  for (const channel of channels) {
    const key = channelKey(channel.url);
    if (key) lookup.set(key, channel);
  }
  return lookup;
}

/**
 * Sleep helper for delays.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
