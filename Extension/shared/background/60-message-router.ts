
interface BgRuntimeMessage {
  type?: string;
  body?: {
    link: string; kind: string; words?: string[] | null; rank?: string | null;
    withhold?: number | null; domain?: string | null; subdomain?: string | null;
  };
  tabId?: unknown; links?: string[]; kind?: string; words?: string[] | null;
  rank?: string | null; withhold?: number | null; domain?: string | null;
  subdomain?: string | null; jobId?: string; includeItems?: boolean; cardId?: unknown;
  active?: boolean; failed?: boolean; recent?: boolean;
  payload?: BgLiveProgressPayload; sourcePayload?: unknown; candidates?: string[]; url?: string; urlHint?: BgUrlHint; media?: string;
}

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  (async () => {
    try {
      const msg = rawMessage as BgRuntimeMessage;
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
          const body = msg.body as NonNullable<BgRuntimeMessage["body"]>;
          const data = await gqlWs<{ subscribe: { ok: boolean } }>(
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
          const data = await gqlWs<{ startYoutubeImport: Record<string, unknown> }>(
            `mutation StartYouTubeImport($payload: JSON!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
              startYoutubeImport(payload: $payload, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { jobId status requested processed resolved added skipped failed }
            }`,
            {
              payload: msg.sourcePayload,
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
          const data = await gqlWs<{ youtubeImportJob: Record<string, unknown> }>(
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
          const data = await gqlWs<{ retryYoutubeImport: Record<string, unknown> }>(
            `mutation RetryYouTubeImport($jobId: String!) {
              retryYoutubeImport(jobId: $jobId) { jobId status requested processed resolved added skipped failed }
            }`,
            { jobId: msg.jobId },
          );
          sendResponse({ ok: true, data: data.retryYoutubeImport });
          break;
        }
        case "dreamedia:rerunYoutubeImport": {
          const data = await gqlWs<{ rerunYoutubeImport: Record<string, unknown> }>(
            `mutation RerunYouTubeImport($jobId: String!) {
              rerunYoutubeImport(jobId: $jobId) { jobId status requested processed resolved added skipped failed }
            }`,
            { jobId: msg.jobId },
          );
          sendResponse({ ok: true, data: data.rerunYoutubeImport });
          break;
        }
        case "dreamedia:deleteYoutubeImport": {
          const data = await gqlWs<{ deleteYoutubeImport: boolean }>(
            `mutation DeleteYouTubeImport($jobId: String!) {
              deleteYoutubeImport(jobId: $jobId)
            }`,
            { jobId: msg.jobId },
          );
          sendResponse({ ok: true, data: data.deleteYoutubeImport });
          break;
        }
        case "dreamedia:updateYoutubeImportHistory": {
          if (!msg.jobId) throw new Error("Missing import job ID");
          const updated = await updateYoutubeImportHistory(
            msg.jobId,
            msg.active === true,
            msg.failed === true,
            msg.recent === true,
          );
          sendResponse({ ok: true, data: updated });
          break;
        }
        case "dreamedia:hideYoutubeImportHistory": {
          if (!msg.jobId) throw new Error("Missing import job ID");
          await hideYoutubeImportHistory(msg.jobId);
          sendResponse({ ok: true, data: true });
          break;
        }
        case "dreamedia:cards":
          const data = await gqlWs<{ cards: unknown[] }>("query { cards { id name done total } }", {});
          sendResponse({ ok: true, data: { cards: data.cards } });
          break;
        case "dreamedia:addItem":
          sendResponse({
            ok: true,
            data: (await gqlWs<{ addCardItems: Record<string, unknown> }>(
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
              entries: (await gqlWs<{ aniEntries: unknown[] }>(
                "query { aniEntries { id title seasons cursorSeason cursorEpisode } }", {},
              )).aniEntries,
            },
          });
          break;
        case "dreamedia:categories":
          sendResponse({
            ok: true,
            data: {
              categories: (await gqlWs<{ ytCategories: unknown[] }>(
                "query { ytCategories { id name subdomains { id name } } }", {},
              )).ytCategories,
            },
          });
          break;
        case "dreamedia:progress":
          sendResponse({ ok: true, data: await liveGql(M_PROGRESS, msg.payload as BgLiveProgressPayload) });
          break;
        case "dreamedia:liveEnd":
          sendResponse({ ok: true, data: await liveGql(M_END, msg.payload as BgLiveProgressPayload) });
          break;
        case "dreamedia:anchor":
          sendResponse({ ok: true, data: await anchorBind(
            sender.tab?.id, msg.candidates as string[], msg.url as string, msg.urlHint || {},
          ) });
          break;
        case "dreamedia:trackingStatus": {
          const tabId = Number(msg.tabId);
          if (!Number.isInteger(tabId)) throw new Error("No active tab to inspect");
          let data: unknown = null;
          try { data = await chrome.tabs.sendMessage(tabId, { type: "dreamedia:getTrackingStatus" }); }
          catch (_error) { /* the current page may predate allowlist activation */ }
          if (!data) {
            let tab: chrome.tabs.Tab | null = null;
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
          sendResponse({ ok: true, data: { host, registered: hit || null }, host, registered: hit || null });
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
    } catch (error: unknown) {
      sendResponse({ ok: false, error: bgErrorMessage(error, "Background operation failed") });
    }
  })();
  return true; // async response
});
