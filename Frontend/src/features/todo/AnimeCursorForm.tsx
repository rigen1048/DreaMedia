import { useEffect, useState } from "react";

type AnimeCursorFormProps = {
  season: number;
  episode: number | null;
  seconds: number | null;
  onSave: (season: number, episode: number | null, seconds: number | null) => void;
};

export function AnimeCursorForm({
  season,
  episode: savedEpisode,
  seconds: savedSeconds,
  onSave,
}: AnimeCursorFormProps) {
  const [episode, setEpisode] = useState(String(savedEpisode ?? ""));
  const [seconds, setSeconds] = useState(String(savedSeconds ?? ""));

  useEffect(() => {
    setEpisode(String(savedEpisode ?? ""));
    setSeconds(String(savedSeconds ?? ""));
  }, [savedEpisode, savedSeconds]);

  const applyCursor = () => {
    const nextEpisode = episode.trim() ? Number(episode) : null;
    const nextSeconds = seconds.trim() ? Number(seconds) : null;
    const invalidEpisode =
      nextEpisode !== null && (!Number.isInteger(nextEpisode) || nextEpisode < 0);
    const invalidSeconds =
      nextSeconds !== null && (!Number.isInteger(nextSeconds) || nextSeconds < 0);
    if (invalidEpisode || invalidSeconds) return;
    onSave(season, nextEpisode, nextSeconds);
  };

  return (
    <div className="cursor-form">
      <span>Forward-only cursor</span>
      <label>
        Episode
        <input
          type="number"
          min="0"
          value={episode}
          onChange={(event) => setEpisode(event.target.value)}
        />
      </label>
      <label>
        Position (seconds)
        <input
          type="number"
          min="0"
          value={seconds}
          onChange={(event) => setSeconds(event.target.value)}
        />
      </label>
      <button className="quiet-action" onClick={applyCursor}>
        Save cursor
      </button>
    </div>
  );
}
