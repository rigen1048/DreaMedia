/* Conservative anime episode hints from a watch-page URL.
 * Anime identity still comes from the page title/backend match; numeric IDs
 * such as ?anime=63801 are never treated as episode numbers. */
(() => {
  interface AnimeUrlHint {
    season: number | null;
    episode: number | null;
    source: string;
    confidence: "none" | "medium" | "high";
  }

  interface AnimeUrlApi {
    parse(rawUrl: string): AnimeUrlHint;
  }

  const EPISODE_KEYS = ["ep_num", "episode_num", "episode_no", "episode", "ep"];
  const SEASON_KEYS = ["season_num", "season_no", "season", "s"];
  const ROUTE_ROOTS = new Set(["watch", "episode", "episodes", "play"]);

  function numeric(value: unknown): number | null {
    const text = String(value ?? "").trim();
    if (!/^\d{1,5}$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function getQueryHint(
    url: URL,
    keys: readonly string[]
  ): { value: number | null; source: string; ambiguous: boolean } {
    const entries: [string, string][] = [];
    url.searchParams.forEach((value, key) => entries.push([key, value]));
    for (const wanted of keys) {
      const matches = entries.filter(([key]) => key.toLowerCase() === wanted);
      if (!matches.length) continue;
      if (matches.length !== 1) {
        return { value: null, source: `query:${wanted}`, ambiguous: true };
      }
      const match = matches[0];
      if (!match) continue;
      const value = numeric(match[1]);
      if (value == null) return { value: null, source: "", ambiguous: false };
      return { value, source: `query:${wanted}`, ambiguous: false };
    }
    return { value: null, source: "", ambiguous: false };
  }

  function decoded(segment: string): string {
    try { return decodeURIComponent(segment); } catch (_error) { return segment; }
  }

  function getPathHint(
    pathname: string
  ): { season: number | null; episode: number | null; source: string } {
    const raw = pathname.split("/").filter(Boolean);
    const parts = raw.map(decoded);
    let season: number | null = null;
    let episode: number | null = null;
    let source = "";

    // Season markers can precede a separate ep-N segment.
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const joined = parts[i] ?? "";
      const seasonEpisode = joined.match(/(?:^|[-_])s(?:eason)?[-_]?0*(\d+)[-_]?e(?:p(?:isode)?)?[-_]?0*(\d+)$/i);
      if (seasonEpisode) {
        season = numeric(seasonEpisode[1]);
        episode = numeric(seasonEpisode[2]);
        source = "path:season-episode";
        if (episode != null) return { season, episode, source };
      }
      const seasonOnly = joined.match(/(?:^|[-_])(?:season|s)[-_]?0*(\d+)$/i);
      if (seasonOnly && season == null) season = numeric(seasonOnly[1]);
    }

    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const joined = parts[i] ?? "";
      const labeled = joined.match(/(?:^|[-_])(?:ep|episode)[-_]?0*(\d+)$/i);
      if (labeled) {
        episode = numeric(labeled[1]);
        source = "path:episode-marker";
        if (episode != null) return { season, episode, source };
      }
    }

    const previous = parts.at(-2) ?? "";
    if (["ep", "episode", "episodes"].includes(previous.toLowerCase())) {
      episode = numeric(parts.at(-1));
      if (episode != null) return { season, episode, source: "path:episode-marker" };
    }

    const last = parts.at(-1) || "";
    const root = (parts[0] || "").toLowerCase();
    // On recognized watch-style routes the final numeric path segment is a
    // useful fallback (/watch/21/2, /watch/one-piece-21/518). Earlier IDs
    // are deliberately ignored. Do not apply this to arbitrary /anime/1234.
    if (ROUTE_ROOTS.has(root) && parts.length >= 3 && /^\d{1,5}$/.test(last)) {
      episode = numeric(last);
      if (episode != null) return { season, episode, source: "path:trailing-number" };
    }
    return { season, episode: null, source: "" };
  }

  function parse(rawUrl: string): AnimeUrlHint {
    let url: URL;
    try { url = new URL(rawUrl); } catch (_error) {
      return { season: null, episode: null, source: "", confidence: "none" };
    }
    const seasonHint = getQueryHint(url, SEASON_KEYS);
    const episodeHint = getQueryHint(url, EPISODE_KEYS);
    if (episodeHint.ambiguous) {
      return { season: null, episode: null, source: "ambiguous-url", confidence: "none" };
    }
    const pathHint = getPathHint(url.pathname);
    const season = seasonHint.value ?? pathHint.season;
    const episode = episodeHint.value ?? pathHint.episode;
    const source = episodeHint.value != null
      ? episodeHint.source
      : pathHint.source;
    return {
      season,
      episode,
      source,
      confidence: episodeHint.value != null || source === "path:episode-marker"
        ? (episode == null ? "none" : "high")
        : episode != null ? "medium" : "none",
    };
  }

  (window as Window & { DreaMediaAnimeUrl?: AnimeUrlApi }).DreaMediaAnimeUrl = { parse };
})();
