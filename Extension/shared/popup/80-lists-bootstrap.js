
// ---- lists ----
function fillOptions(select, rows, emptyLabel) {
  // DOM APIs only — server-derived names are textContent, never innerHTML
  // (2026 review: crafted titles could inject markup into the popup).
  select.replaceChildren();
  if (!rows.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
    return;
  }
  for (const row of rows) {
    const option = document.createElement("option");
    option.value = row.value;
    option.textContent = row.label;
    select.append(option);
  }
}

async function loadLists(configured, updateConnection = true) {
  const cards = await send("dreamedia:cards");
  if (cards.ok) {
    fillOptions(
      $("card"),
      (cards.data.cards || []).map((c) => ({
        value: String(c.id),
        label: `${c.name || "Untitled"} (${c.done}/${c.total})`,
      })),
      "No custom playlists in Todo",
    );
  } else {
    fillOptions($("card"), [], configured ? "Couldn’t load playlists" : "Connect DreaMedia to load playlists");
  }
  const categoryResult = await send("dreamedia:categories");
  if (categoryResult.ok) {
    categories = categoryResult.data.categories || [];
    fillDatalist("domainSuggestions", categories.map((row) => row.name));
  } else {
    categories = [];
    fillDatalist("domainSuggestions", []);
  }
  updateCategorySuggestions();
}
async function initializePopup() {
  let configured = false;
  try {
    configured = await loadConfiguration();
    if (configured) await send("dreamedia:refreshDomains");
  } catch (error) {
    status("configStatus", `Couldn’t read settings: ${error.message}`, "err");
    setConnection("err", "Settings unavailable");
    configured = false;
  }
  try {
    await checkSite();
  } catch (error) {
    $("siteHost").textContent = "Site unavailable";
    status("siteStatus", error.message, "err");
  }
  await loadLists(configured);
  if (configured) await resumeImportJobs();
  await refreshTrackingStatus();
  setInterval(() => void refreshTrackingStatus(), 1000);
}
void initializePopup();
