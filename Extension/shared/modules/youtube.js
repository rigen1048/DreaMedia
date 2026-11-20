/* DreaMedia youtube module (ext v2): page-side behavior for allowlisted
 * 'yt' domains. Subscribe-from-page and playlist add are popup-driven and
 * need no content script; the blocked-content disclaimer (design phase 4)
 * will land here, matching channels from the locally cached blocked list. */
(() => {
  console.debug("[DreaMedia] youtube module active on", location.hostname);
})();
