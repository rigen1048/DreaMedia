const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function timeAgo(input: string | number | null | undefined): string {
  if (!input) return "—";
  const stamp =
    typeof input === "number" ? (input > 1e11 ? input : input * 1000) : Date.parse(input);
  if (Number.isNaN(stamp)) return "—";
  const delta = Date.now() - stamp;
  if (delta < 0) return inFuture(-delta);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.round(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.round(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.round(delta / DAY)}d ago`;
  return new Date(stamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function inFuture(delta: number): string {
  if (delta < HOUR) return `in ${Math.max(1, Math.round(delta / MINUTE))}m`;
  if (delta < DAY) return `in ${Math.round(delta / HOUR)}h`;
  return `in ${Math.round(delta / DAY)}d`;
}

export function formatDate(input: string | number | null | undefined): string {
  if (!input) return "TBA";
  const stamp = typeof input === "number" ? input * 1000 : Date.parse(input);
  if (Number.isNaN(stamp)) return "TBA";
  return new Date(stamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatAiring(ts: number | null, episode: number | null): string {
  if (!ts) return "No date";
  const date = new Date(ts * 1000);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (Date.now() > ts) return `${weekday} ${time}`;
  return `${weekday} ${time}${episode ? ` · ep ${episode}` : ""}`;
}

export function clockTime(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function progress(done: number, total: number): number {
  if (!total) return 0;
  return clamp(Math.round((done / total) * 100), 0, 100);
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
