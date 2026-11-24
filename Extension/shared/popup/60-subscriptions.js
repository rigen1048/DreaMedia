
action("scanSubscriptions", "importStatus", async () => {
  scannedSubscriptions = [];
  subscriptionScanComplete = false;
  setAddSourceLabel("Add source");
  $("importPreview").hidden = true;
  const tab = await currentTab();
  if (!tab?.id) {
    setImportScanStatus("Open YouTube's channel subscriptions page first.", "err");
    return;
  }
  setImportScanStatus("Scanning the page and loading more channels…");
  const response = await send("dreamedia:scanYoutubeSubscriptions", { tabId: tab.id });
  if (!response.ok) {
    setImportScanStatus(response.error || "Subscription scan failed.", "err");
    return;
  }
  scannedSubscriptions = Array.isArray(response.data?.channels) ? response.data.channels : [];
  subscriptionScanComplete = response.data?.complete === true;
  renderSubscriptionPreview();
  if (!scannedSubscriptions.length) {
    setImportScanStatus("No channel links found. Check that this is the channel subscriptions page and you are signed in.", "err");
    return;
  }
  if (subscriptionScanComplete) {
    const count = scannedSubscriptions.length;
    setAddSourceLabel(`Add ${count} ${count === 1 ? "source" : "sources"}`);
    setImportScanStatus(`${scannedSubscriptions.length} unique channel(s) found. Review the preview, then choose Add sources.`, "ok");
  } else {
    setImportScanStatus(`Found ${scannedSubscriptions.length}, but the page did not reach a stable end. Scroll through the page and scan again before adding sources.`, "err");
  }
});

// ---- subscribe ----
action("subscribe", "subStatus", async () => {
  if (page.subscriptionChannels && !subscriptionScanComplete) {
    throw new Error("Scan the complete channel list first; Add Source will add each scanned channel.");
  }
  if (subscriptionScanComplete) {
    if (!scannedSubscriptions.length) throw new Error("Scan the channel list before adding sources.");
    const options = selectedSourceOptions(true);
    const response = await send("dreamedia:startYoutubeImport", {
      links: scannedSubscriptions.map((channel) => channel.url),
      ...options,
    });
    if (!response.ok) throw new Error(response.error || "Could not queue the channel import.");
    const jobId = response.data?.jobId;
    if (!jobId) throw new Error("The backend did not return an import job ID.");
    const count = scannedSubscriptions.length;
    scannedSubscriptions = [];
    subscriptionScanComplete = false;
    renderSubscriptionPreview();
    setAddSourceLabel("Add source");
    await trackImportJob(jobId, count);
    return;
  }
  const tab = await currentTab();
  if (!tab?.url) return status("subStatus", "Open a YouTube page first", "err");
  const body = { ...selectedSourceOptions(), link: tab.url };
  status("subStatus", "Subscribing…");
  const r = await send("dreamedia:subscribe", { body });
  const subscribed = r.ok && r.data?.ok;
  status("subStatus", subscribed ? "Source added" : `Couldn’t add source: ${r.error || r.data?.error || "Unknown error"}`, subscribed ? "ok" : "err");
});
