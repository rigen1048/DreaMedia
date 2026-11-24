
// ---- playlist add ----
action("addVideo", "cardStatus", async () => {
  const tab = await currentTab();
  if (!tab?.url) return status("cardStatus", "Open a video page first", "err");
  const cardId = $("card").value;
  if (!cardId) return status("cardStatus", "Pick a playlist first", "err");
  status("cardStatus", "Adding video…");
  const r = await send("dreamedia:addItem", { cardId, links: [tab.url] });
  const added = Boolean(r.ok && r.data?.added > 0);
  const duplicate = Boolean(r.ok && r.data && r.data.added === 0 && r.data.requested > 0 && !r.data.errors?.length);
  const reason = r.data?.errors?.[0]?.replace(`${tab.url}: `, "") || r.error;
  status("cardStatus", added ? "Video added" : duplicate ? "Already in this playlist" : reason || "No video was added", added || duplicate ? "ok" : "err");
});
