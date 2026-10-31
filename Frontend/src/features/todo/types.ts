import type { AnimeTrack, AnimeSeason, YoutubeTrack } from "../media";

export type TodoSeason = AnimeTrack["seasons"][number];

export type YoutubeDetailProps = {
  track: YoutubeTrack;
  onBack: () => void;
  onSeen: (videoId: number, seen: boolean) => void;
};

export type AnimeDetailActionProps = {
  show: AnimeTrack;
  currentSeason?: TodoSeason;
  onBack: () => void;
  onSeason: (seasonNo: number) => void;
  onWatch: (seasonNo: number, watched: boolean) => void;
  onCursor: (season: number, episode: number | null, seconds: number | null) => void;
  onRange: (from: number, to: number) => void;
  onFinish: () => void;
  onCanon: (value: boolean) => void;
  onDelete: () => void;
};

export type SeasonListProps = {
  seasons: AnimeSeason[];
  activeSeasonNo?: number;
  onSelect: (seasonNo: number) => void;
};
