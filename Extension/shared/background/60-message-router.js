
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "dreamedia:connectionStatus":
          if (!(await hasEnabledSiteTab())) {
            stopWsForNoEnabledSite();
          } else if (connectionState.status === "connected") {
            if (!wsTransportResponsive()) {
              wsDead("WebSocket is not responsive");
              sendResponse({ ok: true, data: { status: "connecting", reason: "Reconnecting" } });
              break;
            }
          }
          sendResponse({ ok: true, data: connectionState });
          if (await hasEnabledSiteTab()) void ensureWs();
          break;
        case "dreamedia:connect":
          if (!(await hasEnabledSiteTab())) {
            stopWsForNoEnabledSite();
            sendResponse({ ok: true, data: connectionState });
            break;
          }
          await waitForWsReady();
          sendResponse({ ok: true, data: connectionState });
          break;
        case "dreamedia:subscribe": {
          const body = msg.body;
          const data = await gqlWs(
            `mutation Subscribe($link: String!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
              subscribe(link: $link, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { ok channelId }
            }`,
            {
              link: body.link,
              kind: body.kind,
              words: body.words ?? null,
              rank: body.rank ?? null,
              withhold: body.withhold ?? null,
              domain: body.domain ?? null,
              subdomain: body.subdomain ?? null,
            },
          );
          sendResponse({ ok: true, data: { ok: data.subscribe.ok } });
          break;
        }
        case "dreamedia:scanYoutubeSubscriptions": {
          const result = await scanYoutubeSubscriptions(Number(msg.tabId));
          sendResponse({ ok: true, data: result });
          break;
        }
        case "dreamedia:startYoutubeImport": {
          const data = await gqlWs(
            `mutation StartYouTubeImport($links: [String!]!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
              startYoutubeImport(links: $links, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { jobId status requested processed resolved added skipped failed }
            }`,
            {
              links: msg.links,
              kind: msg.kind,
              words: msg.words ?? null,
              rank: msg.rank ?? null,
              withhold: msg.withhold ?? null,
              domain: msg.domain ?? null,
              subdomain: msg.subdomain ?? null,
            },
          );
          sendResponse({ ok: true, data: data.startYoutubeImport });
          break;
        }
        case "dreamedia:youtubeImportStatus": {
          const data = await gqlWs(
            `query YoutubeImportJob($jobId: String!, $includeItems: Boolean!) {
              youtubeImportJob(jobId: $jobId, includeItems: $includeItems) {
                jobId status requested processed resolved added skipped failed errors
                items { ordinal link status error retryable }
              }
            }`,
            { jobId: msg.jobId, includeItems: msg.includeItems === true },
          );
          sendResponse({ ok: true, data: data.youtubeImportJob });
          break;
        }
        case "dreamedia:retryYoutubeImport": {
          const data = await gqlWs(
            `mutation RetryYouTubeImport($jobId: String!) {
              retryYoutubeImport(jobId: $jobId) { jobId status requested processed resolved added skipped failed }
            }`,
            { jobId: msg.jobId },
          );
          sendResponse({ ok: true, data: data.retryYoutubeImport });
          break;
        }
        case "dreamedia:cards":
          sendResponse({ ok: true, data: { cards: (await gqlWs("query { cards { id name done total } }", {})).cards } });
          break;
        case "dreamedia:addItem":
          sendResponse({
            ok: true,
            data: (await gqlWs(
              `mutation AddItems($cardId: Int!, $links: [String!]!) {
                addCardItems(cardId: $cardId, links: $links) { added requested errors }
              }`,
              { cardId: Number(msg.cardId), links: msg.links },
            )).addCardItems,
          });
          break;
        case "dreamedia:aniEntries":
          sendResponse({
            ok: true,
            data: {
              entries: (await gqlWs(
                "query { aniEntries { id title seasons cursorSeason cursorEpisode } }", {},
              )).aniEntries,
            },
          });
          break;
        case "dreamedia:categories":
          sendResponse({
            ok: true,
            data: {
              categories: (await gqlWs(
                "query { ytCategories { id name subdomains { id name } } }", {},
              )).ytCategories,
            },
          });
          break;
        case "dreamedia:progress":
          sendResponse({ ok: true, data: await liveGql(M_PROGRESS, msg.payload) });
          break;
        case "dreamedia:liveEnd":
          sendResponse({ ok: true, data: await liveGql(M_END, msg.payload) });
          break;
        case "dreamedia:anchor":
          sendResponse({ ok: true, data: await anchorBind(
            sender.tab?.id, msg.candidates, msg.url, msg.urlHint || {},
          ) });
          break;
        case "dreamedia:trackingStatus": {
          const tabId = Number(msg.tabId);
          if (!Number.isInteger(tabId)) throw new Error("No active tab to inspect");
          let data = null;
          try { data = await chrome.tabs.sendMessage(tabId, { type: "dreamedia:getTrackingStatus" }); }
          catch (_error) { /* the current page may predate allowlist activation */ }
          if (!data) {
            let tab = null;
            try { tab = await chrome.tabs.get(tabId); } catch (_error) { /* tab closed */ }
            if (tab?.url && await injectAnimeIntoTab(tabId, tab.url)) {
              try { data = await chrome.tabs.sendMessage(tabId, { type: "dreamedia:getTrackingStatus" }); }
              catch (_error) { /* page lifecycle or injection may still be settling */ }
            }
          }
          sendResponse({ ok: true, data: data || null });
          break;
        }
        case "dreamedia:domainStatus": {
          const host = normalizeDomain(msg.url);
          const hit = (await cachedDomains()).find(
            (d) => host === d.domain || host.endsWith(`.${d.domain}`),
          );
          sendResponse({ ok: true, host, registered: hit || null });
          break;
        }
        case "dreamedia:addDomain": {
          const domain = normalizeDomain(msg.domain);
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!domain || !urlMatchesDomain(activeTab?.url || "", domain)) {
            throw new Error("Open the site in the active tab to enable it.");
          }
          pendingSiteDomains.add(domain);
          try {
            const data = await gqlWs(
              `mutation AddDomain($domain: String!, $media: String!) {
                addDomain(domain: $domain, media: $media) { id domain media enabled }
              }`,
              { domain: msg.domain, media: msg.media },
            );
            await refreshDomains();
            sendResponse({ ok: true, data });
          } finally {
            pendingSiteDomains.delete(domain);
            if (await hasEnabledSiteTab()) void ensureWs();
            else stopWsForNoEnabledSite();
          }
          break;
        }
        case "dreamedia:refreshDomains":
          await refreshAll();
          sendResponse({ ok: true });
          break;
        case "dreamedia:blockedYT":
          sendResponse({ ok: true, data: await cachedBlocked() });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true; // async response
});
