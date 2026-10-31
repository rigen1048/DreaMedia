import { useAuthActions } from "./actions/auth";
import { useAniActions } from "./actions/ani";
import { useFeedActions } from "./actions/feed";
import { useNotificationActions } from "./actions/notifications";
import { useAfterAction } from "./actions/shared";
import { useYoutubeActions } from "./actions/youtube";

type MediaActionOptions = {
  invalidate: () => Promise<void>;
  reset: () => void;
};

export function useMediaActions({ invalidate, reset }: MediaActionOptions) {
  const after = useAfterAction(invalidate);
  const auth = useAuthActions({ after, reset });
  const youtube = useYoutubeActions({ after, invalidate });
  const feed = useFeedActions(after);
  const messages = useNotificationActions(after);
  const ani = useAniActions(after);

  return {
    ...auth,
    ...youtube,
    ...feed,
    ...messages,
    ...ani,
  };
}
