import { useEffect, useState } from "react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";

/**
 * Direct season/episode editor. The "+1" cursor and the season bump only move
 * forward by design; this is the way back when a bump overshoots (or when the
 * anime was added with the wrong starting season).
 */
export function ProgressEditor({
  entryId,
  season,
  episode,
  compact = false,
}: {
  entryId: number;
  season: number;
  episode: number;
  compact?: boolean;
}) {
  const { notify, refresh } = useApp();
  const [draftSeason, setDraftSeason] = useState(season);
  const [draftEpisode, setDraftEpisode] = useState(episode);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraftSeason(season);
    setDraftEpisode(episode);
  }, [season, episode]);

  const dirty = draftSeason !== season || draftEpisode !== episode;

  const save = async () => {
    const nextSeason = Math.max(1, Math.round(draftSeason) || 1);
    const nextEpisode = Math.max(0, Math.round(draftEpisode) || 0);
    setBusy(true);
    try {
      await api.aniSetProgress(entryId, nextSeason, nextEpisode);
      await refresh();
      notify(`Progress set to S${nextSeason} E${nextEpisode}`, "ok");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not set progress", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "progress-edit progress-edit--compact" : "progress-edit"}>
      <span className="progress-edit__label">{compact ? "S/E" : "Set progress"}</span>
      <input
        className="ep-input"
        type="number"
        min={1}
        value={draftSeason}
        aria-label="Season"
        onChange={(event) => setDraftSeason(Number(event.target.value))}
        onKeyDown={(event) => event.key === "Enter" && void save()}
      />
      <span className="faint">/</span>
      <input
        className="ep-input"
        type="number"
        min={0}
        value={draftEpisode}
        aria-label="Episode"
        onChange={(event) => setDraftEpisode(Number(event.target.value))}
        onKeyDown={(event) => event.key === "Enter" && void save()}
      />
      <button
        className="btn btn--sm"
        disabled={busy || !dirty}
        onClick={() => void save()}
        title="Move the cursor here — backwards is allowed on purpose"
      >
        {busy ? "Saving…" : "Update"}
      </button>
    </div>
  );
}
