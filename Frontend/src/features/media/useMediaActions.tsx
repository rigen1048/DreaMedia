import { useAuthActions } from "./actions/auth";
import { useAniActions } from "./actions/ani";
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
  const notifications = useNotificationActions(after);
  const ani = useAniActions(after);

  return {
    ...auth,
    ...youtube,
    ...notifications,
    ...ani,
  };
}
