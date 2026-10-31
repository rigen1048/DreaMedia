import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useMedia, type AnimeTrack, type MediaSource } from "../media";

const firstAvailableSeason = (show: AnimeTrack): number | null =>
  show.cursorSeason ??
  show.seasons.find((season) => !season.watched)?.seasonNo ??
  show.seasons[0]?.seasonNo ??
  null;

export function useTodoSelection() {
  const [location, setLocation] = useLocation();
  const { youtubeTracks, anime, trackAnime } = useMedia();
  const [source, setSource] = useState<MediaSource>("youtube");
  const [selectedYoutube, setSelectedYoutube] = useState<number | null>(null);
  const [selectedAnime, setSelectedAnime] = useState<number | null>(null);
  const [activeSeasonNo, setActiveSeasonNo] = useState<number | null>(null);
  const [animeFilter, setAnimeFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [animeTitle, setAnimeTitle] = useState("");
  const [animeList, setAnimeList] = useState<AnimeTrack["list"]>("watching");
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const activeTrack = youtubeTracks.find((track) => track.channelId === selectedYoutube);
  const activeShow = anime.find((show) => show.backendId === selectedAnime);
  const currentSeason =
    activeShow?.seasons.find((season) => season.seasonNo === activeSeasonNo) ??
    activeShow?.seasons[0];
  const normalizedQuery = query.toLowerCase();

  const visibleYoutube = useMemo(
    () =>
      youtubeTracks.filter((track) =>
        `${track.title} ${track.url} ${track.domain} ${track.subdomain}`
          .toLowerCase()
          .includes(normalizedQuery),
      ),
    [normalizedQuery, youtubeTracks],
  );
  const visibleAnime = useMemo(
    () =>
      anime.filter((show) => {
        const matchesStatus =
          animeFilter === "All" ||
          (animeFilter === "Completed"
            ? show.status === "Completed"
            : show.status === "Watching" || show.status === "Releasing");
        return (
          matchesStatus && `${show.title} ${show.list}`.toLowerCase().includes(normalizedQuery)
        );
      }),
    [anime, animeFilter, normalizedQuery],
  );

  useEffect(() => {
    const focus = () => {
      searchRef.current?.focus();
      window.setTimeout(() => {
        if (searchRef.current?.value === "/") setQuery("");
      }, 0);
    };
    window.addEventListener("dreamedia:focus-search", focus);
    return () => window.removeEventListener("dreamedia:focus-search", focus);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    const item = params.get("item")?.toLowerCase();
    const sourceParam = params.get("source");
    if (sourceParam === "ani") setSource("ani");
    if (sourceParam === "youtube") setSource("youtube");
    if (!item) return;

    if (sourceParam === "youtube") {
      const track = youtubeTracks.find(
        (entry) => entry.title.toLowerCase() === item || entry.url.toLowerCase() === item,
      );
      if (track) {
        setSource("youtube");
        setSelectedYoutube(track.channelId);
      }
    }
    if (sourceParam === "ani") {
      const show = anime.find((entry) => entry.title.toLowerCase() === item);
      if (show) {
        setSource("ani");
        setSelectedAnime(show.backendId);
        setActiveSeasonNo(
          show.cursorSeason ??
            show.seasons.find((season) => !season.watched)?.seasonNo ??
            show.seasons[0]?.seasonNo ??
            null,
        );
      }
    }
  }, [anime, location, youtubeTracks]);

  const back = () => {
    setSelectedYoutube(null);
    setSelectedAnime(null);
    setActiveSeasonNo(null);
    setLocation("/track");
  };
  const switchSource = (nextSource: MediaSource) => {
    setSource(nextSource);
    back();
  };
  const openYoutube = (channelId: number) => setSelectedYoutube(channelId);
  const openAnime = (show: AnimeTrack) => {
    setSelectedAnime(show.backendId);
    setActiveSeasonNo(
      show.cursorSeason ??
        show.seasons.find((season) => !season.watched)?.seasonNo ??
        show.seasons[0]?.seasonNo ??
        null,
    );
  };
  const run = async (operation: () => Promise<void>) => {
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Backend update failed.");
    }
  };
  const submitAnime = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await trackAnime(animeTitle.trim(), animeList);
      setAnimeTitle("");
      setAddOpen(false);
    });
  };

  return {
    source,
    activeTrack,
    activeShow,
    currentSeason,
    animeFilter,
    setAnimeFilter,
    query,
    setQuery,
    searchRef,
    addOpen,
    setAddOpen,
    animeTitle,
    setAnimeTitle,
    animeList,
    setAnimeList,
    error,
    visibleYoutube,
    visibleAnime,
    back,
    switchSource,
    openYoutube,
    openAnime,
    setActiveSeasonNo,
    run,
    submitAnime,
  };
}
