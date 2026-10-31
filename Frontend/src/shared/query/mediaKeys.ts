export const mediaQueryKeys = {
  all: ["dreamedia", "media"] as const,
  feed: () => [...mediaQueryKeys.all, "feed"] as const,
  management: () => [...mediaQueryKeys.all, "management"] as const,
  messages: () => [...mediaQueryKeys.all, "messages"] as const,
};
