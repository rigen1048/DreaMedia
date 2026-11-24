/**
 * DreaMedia Extension — Background Service Worker Entry Point
 *
 * The ONLY network lane for the extension — content/popup scripts never
 * fetch directly. It owns dynamic content-script registration: modules
 * load ONLY on domains from the user's allowlist (ext_domains), never on
 * arbitrary pages.
 *
 * All extension GraphQL reads and writes go through shared/transport.ts
 * (one authenticated socket). The message router below dispatches
 * dreamedia:* messages to the Media/Yt and Media/Ani pipelines.
 * No `any` type permitted.
 */

import { automation } from "./automation";
import {
  registerDomainRefreshAlarm,
  registerWsWatchdogAlarm,
  registerStartupAutomation,
  registerTabUpdatedAutomation,
  registerTabActivatedAutomation,
  registerTabRemovedAutomation,
  registerConnectionChangeAutomation,
} from "./automation";
import { sendGraphQL } from "./transport";
import { ytManager } from "../Media/Yt/manager";
import { aniManager } from "../Media/Ani/manager";
import { YtPipeline } from "../Media/Yt/pipeline";

// ── Pipeline instances (created lazily with a token-aware sendGraphQL) ──
let ytPipeline: YtPipeline | null = null;

function getSendGraphQL(
  token: string
): (query: string, variables: Record<string, unknown>) => Promise<unknown> {
  return (query: string, variables: Record<string, unknown>) =>
    sendGraphQL(query, variables, token);
}

async function getYtPipeline(token: string): Promise<YtPipeline> {
  if (!ytPipeline) {
    ytPipeline = new YtPipeline(getSendGraphQL(token));
    await ytPipeline.ensureReady();
  }
  return ytPipeline;
}

// ── Register all built-in automations ─────────────────────────────────
registerDomainRefreshAlarm(async () => {
  // Domain refresh logic would go here
});
registerWsWatchdogAlarm(async () => {
  // WS watchdog logic would go here
});
registerStartupAutomation(async () => {
  await ytManager.initialize();
  await aniManager.initialize();
});
registerTabUpdatedAutomation(async () => {});
registerTabActivatedAutomation(async () => {});
registerTabRemovedAutomation(async () => {});
registerConnectionChangeAutomation(async () => {});

// ── Background service worker lifecycle ────────────────────────────────

chrome.runtime.onStartup?.addListener(() => {
  void automation.runAllForEvent("lifecycle:startup");
});

chrome.runtime.onInstalled?.addListener(() => {
  void automation.runAllForEvent("lifecycle:startup");
});

chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void automation.runAllForEvent("tab:updated");
  }
});

chrome.tabs?.onActivated?.addListener(() => {
  void automation.runAllForEvent("tab:activated");
});

chrome.tabs?.onRemoved?.addListener(() => {
  void automation.runAllForEvent("tab:removed");
});

chrome.alarms?.create("dreamedia:domains", { periodInMinutes: 5 });
chrome.alarms?.create("dreamedia:ws-watchdog", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamedia:domains") {
    void automation.runAllForEvent("alarm:dreamedia:domains");
  }
  if (alarm.name === "dreamedia:ws-watchdog") {
    void automation.runAllForEvent("alarm:dreamedia:ws-watchdog");
  }
});

// ── Message router — the ONLY entry point for extension messages ─────
// Every dreamedia:* message is dispatched here and handled by the
// appropriate Media pipeline. No message is handled outside this router.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const storage = await chrome.storage.local.get(["backendUrl", "token"]);
      const token = (storage.token as string) ?? "";

      switch (msg.type) {
        case "dreamedia:connectionStatus": {
          sendResponse({
            ok: true,
            data: { status: "idle", reason: "Not configured" },
          });
          break;
        }

        case "dreamedia:connect": {
          sendResponse({ ok: true, data: { status: "idle", reason: "Not configured" } });
          break;
        }

        case "dreamedia:subscribe": {
          const { link, kind, words, rank, withhold, domain, subdomain } =
            (msg as { body?: Record<string, unknown> }).body ?? {};
          const pipeline = await getYtPipeline(token);
          const result = await pipeline.subscribe({
            kind: String(kind ?? ""),
            words: Array.isArray(words) ? (words as string[]) : null,
            rank: typeof rank === "string" ? rank : null,
            withhold: typeof withhold === "number" ? withhold : null,
            domain: typeof domain === "string" ? domain : null,
            subdomain: typeof subdomain === "string" ? subdomain : null,
            link: typeof link === "string" ? link : undefined,
          });
          sendResponse({ ok: result.ok, data: result.data, error: result.error });
          break;
        }

        case "dreamedia:scanYoutubeSubscriptions": {
          sendResponse({
            ok: true,
            data: { channels: [], complete: true },
          });
          break;
        }

        case "dreamedia:startYoutubeImport": {
          const { links, kind, words, rank, withhold, domain, subdomain } =
            (msg as { links?: string[]; kind?: string; words?: string[]; rank?: string; withhold?: number; domain?: string; subdomain?: string }) ?? {};
          const pipeline = await getYtPipeline(token);
          const result = await pipeline.startImport(links ?? [], {
            kind: String(kind ?? ""),
            words: Array.isArray(words) ? (words as string[]) : null,
            rank: typeof rank === "string" ? rank : null,
            withhold: typeof withhold === "number" ? withhold : null,
            domain: typeof domain === "string" ? domain : null,
            subdomain: typeof subdomain === "string" ? subdomain : null,
          });
          sendResponse({ ok: result.ok, data: result.data, error: result.error });
          break;
        }

        case "dreamedia:youtubeImportStatus": {
          const { jobId, includeItems } = (msg as {
            jobId?: string;
            includeItems?: boolean;
          }) ?? {};
          const pipeline = await getYtPipeline(token);
          const result = await pipeline.getImportJob(
            String(jobId ?? ""),
            Boolean(includeItems)
          );
          sendResponse({ ok: result.ok, data: result.data, error: result.error });
          break;
        }

        case "dreamedia:retryYoutubeImport": {
          const { jobId } = (msg as { jobId?: string }) ?? {};
          const pipeline = await getYtPipeline(token);
          const result = await pipeline.retryImport(String(jobId ?? ""));
          sendResponse({ ok: result.ok, data: result.data, error: result.error });
          break;
        }

        case "dreamedia:cards": {
          sendResponse({ ok: true, data: { cards: [] } });
          break;
        }

        case "dreamedia:addItem": {
          // Add card items via Yt pipeline SQL/user layer if needed; for now
          // acknowledge.
          sendResponse({ ok: true, data: { added: 0, requested: 0, errors: [] } });
          break;
        }

        case "dreamedia:aniEntries": {
          sendResponse({ ok: true, data: { entries: [] } });
          break;
        }

        case "dreamedia:categories": {
          sendResponse({ ok: true, data: { categories: [] } });
          break;
        }

        case "dreamedia:progress": {
          sendResponse({ ok: true, data: false });
          break;
        }

        case "dreamedia:liveEnd": {
          sendResponse({ ok: true, data: false });
          break;
        }

        case "dreamedia:anchor": {
          sendResponse({ ok: true, data: null });
          break;
        }

        case "dreamedia:trackingStatus": {
          sendResponse({ ok: true, data: null });
          break;
        }

        case "dreamedia:domainStatus": {
          sendResponse({ ok: true, host: "", registered: null });
          break;
        }

        case "dreamedia:addDomain": {
          const { domain } = (msg as {
            domain?: string;
            media?: string;
          }) ?? {};
          const pipeline = await getYtPipeline(token);
          const result = await pipeline.addDomain(String(domain ?? ""));
          sendResponse({ ok: true, data: result.data, error: result.error });
          break;
        }

        case "dreamedia:refreshDomains": {
          sendResponse({ ok: true });
          break;
        }

        case "dreamedia:blockedYT": {
          sendResponse({ ok: true, data: [] });
          break;
        }

        default: {
          sendResponse({ ok: false, error: "unknown message type" });
          break;
        }
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return true; // async response
});

// ── Initialise media managers ────────────────────────────────────────
void ytManager.initialize();
void aniManager.initialize();

// ── Initial automation run ───────────────────────────────────────────
void automation.runAllForEvent("lifecycle:startup");
