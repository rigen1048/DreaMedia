const M_ANCHOR = `mutation Anchor($candidates: [String!]!, $pageUrl: String!, $seasonHint: Int, $episodeHint: Int) {
  anchorMatch(candidates: $candidates, pageUrl: $pageUrl, seasonHint: $seasonHint, episodeHint: $episodeHint) {
    entryId title season episode cursorSeason cursorEpisode blocked reason
  }
}`;

async function anchorBind(tabId, candidates, pageUrl, urlHint = {}) {
  const data = await gqlWs(M_ANCHOR, {
    candidates,
    pageUrl,
    seasonHint: urlHint.season ?? null,
    episodeHint: urlHint.episode ?? null,
  });
  const match = data?.anchorMatch;
  if (!match?.entryId || !tabId) return false;
  // Phase 4: a blocked entry shows the disclaimer instead of binding.
  if (match.blocked) {
    await chrome.tabs.sendMessage(tabId, {
      type: "dreamedia:blocked", title: "This anime is on your blocked list.", reason: match.reason,
    }).catch(() => {});
    return true;
  }
  const binding = {
    entryId: match.entryId,
    title: match.title || "",
    season: match.season || match.cursorSeason || 1,
    episode: match.episode || match.cursorEpisode || 1,
    seasonSource: urlHint.season != null ? "url" : match.season != null ? "title" : "cursor",
    episodeSource: urlHint.episode != null ? "url" : match.episode != null ? "title" : "cursor",
  };
  await chrome.tabs.sendMessage(tabId, { type: "dreamedia:bind", binding }).catch(() => {});
  return true;
}
