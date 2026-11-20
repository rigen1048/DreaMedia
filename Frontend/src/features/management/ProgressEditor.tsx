import { useEffect, useState } from "react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Direct season/episode/position editor. The "+1" cursor and the season bump
 * only move forward by design; this is the way back when a bump overshoots
 * (or when the anime was added with the wrong starting point).
 *
 * Supports "halfway watch" — seconds are persisted via aniSetCursor so the
 * frontend can resume mid-episode (P15).
 */
export function ProgressEditor({
  entryId,
  season,
  episode,
  positionSeconds,
  compact = false,
}: {
  entryId: number;
  season: number;
  episode: number;
  positionSeconds?: number | null;
  compact?: boolean;
}) {
  const { notify, refresh } = useApp();
  // Drafts are `number | undefined` so the user can clear a field mid-edit
  // instead of the controlled input snapping straight back to 0 (P12).
  const [draftSeason, setDraftSeason] = useState<number | undefined>(season);
  const [draftEpisode, setDraftEpisode] = useState<number | undefined>(episode);
  const [draftSeconds, setDraftSeconds] = useState<number | undefined>(
    positionSeconds ?? 0,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraftSeason(season);
    setDraftEpisode(episode);
    setDraftSeconds(positionSeconds ?? 0);
  }, [season, episode, positionSeconds]);

  const dirty =
    (draftSeason ?? season) !== season ||
    (draftEpisode ?? episode) !== episode ||
    (draftSeconds ?? 0) !== Math.max(0, positionSeconds ?? 0);

  const save = async () => {
    const nextSeason = Math.max(1, Math.round(draftSeason ?? season));
    const nextEpisode = Math.max(0, Math.round(draftEpisode ?? episode));
    const nextSeconds = Math.max(0, Math.round(draftSeconds ?? 0));
    setBusy(true);
    try {
      await api.aniSetCursor(entryId, nextSeason, nextEpisode, nextSeconds);
      await refresh();
      notify(
        `Progress set to S${nextSeason} E${nextEpisode}${
          nextSeconds > 0 ? ` @ ${nextSeconds}s` : ""
        }`,
        "ok",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not set progress", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{compact ? "S/E" : "Set progress"}</span>
      <Input
        type="number"
        min={1}
        value={draftSeason}
        aria-label="Season"
        onChange={(event) => {
          const v = event.target.value;
          setDraftSeason(v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : draftSeason);
        }}
        onKeyDown={(event) => event.key === "Enter" && void save()}
        className="h-8 w-16 px-2 text-center"
      />
      <span className="text-muted-foreground">/</span>
      <Input
        type="number"
        min={0}
        value={draftEpisode ?? ""}
        aria-label="Episode"
        onChange={(event) => {
          const v = event.target.value;
          setDraftEpisode(v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : draftEpisode);
        }}
        onKeyDown={(event) => event.key === "Enter" && void save()}
        className="h-8 w-16 px-2 text-center"
      />
      <span className="text-muted-foreground">·</span>
      <Input
        type="number"
        min={0}
        value={draftSeconds ?? ""}
        aria-label="Time (seconds)"
        placeholder="0s"
        onChange={(event) => {
          const v = event.target.value;
          setDraftSeconds(v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : draftSeconds);
        }}
        onKeyDown={(event) => event.key === "Enter" && void save()}
        className="h-8 w-20 px-2 text-center"
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || !dirty}
        onClick={() => void save()}
        title="Move the cursor here — backwards is allowed on purpose"
      >
        {busy ? "Saving…" : "Update"}
      </Button>
    </div>
  );
}
