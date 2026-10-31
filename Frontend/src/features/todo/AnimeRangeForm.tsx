import { useState } from "react";
import type { TodoSeason } from "./types";

type AnimeRangeFormProps = {
  seasons: TodoSeason[];
  onRange: (from: number, to: number) => void;
};

export function AnimeRangeForm({ seasons, onRange }: AnimeRangeFormProps) {
  const firstSeason = seasons[0]?.seasonNo ?? 1;
  const lastSeason = seasons.at(-1)?.seasonNo ?? firstSeason;
  const [rangeStart, setRangeStart] = useState(String(firstSeason));
  const [rangeEnd, setRangeEnd] = useState(String(lastSeason));

  return (
    <div className="range-form">
      <span>Easy completion range</span>
      <label>
        From
        <select value={rangeStart} onChange={(event) => setRangeStart(event.target.value)}>
          {seasons.map((season) => (
            <option key={season.id} value={season.seasonNo}>
              S{season.seasonNo}
            </option>
          ))}
        </select>
      </label>
      <label>
        To
        <select value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)}>
          {seasons.map((season) => (
            <option key={season.id} value={season.seasonNo}>
              S{season.seasonNo}
            </option>
          ))}
        </select>
      </label>
      <button
        className="quiet-action"
        onClick={() => onRange(Number(rangeStart), Number(rangeEnd))}
      >
        Complete range
      </button>
    </div>
  );
}
