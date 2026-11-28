/**
 * Shared popup utilities — DOM helpers, message sending, and shared state.
 * No `any` type permitted.
 */

export const IMPORT_TAB_KEY = "importTableTabId";
export const SCAN_TAB_KEY = "scanTableTabId";

export const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element: #${id}`);
  return el;
};

export function send(
  type: string,
  extra: Record<string, unknown> = {}
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type, ...extra },
      (resp) => {
        resolve(
          resp || { ok: false, error: chrome.runtime.lastError?.message ?? "No response" }
        );
      }
    );
  });
}

export function status(id: string, text: string, cls = ""): void {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${cls}`;
}

export async function currentTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

export function formatClock(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—:—";
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function action(
  buttonId: string,
  statusId: string,
  run: () => Promise<void>
): void {
  const button = $(buttonId) as HTMLButtonElement;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      status(statusId, `Failed: ${(error as Error).message}`, "err");
    } finally {
      button.disabled = false;
    }
  });
}

/** Shared mutable state used across popup modules. */
export const shared = {
  categories: [] as { id: number; name: string; subdomains: { id: number; name: string }[] }[],
  page: { kind: "none", playlist: false, subscriptionChannels: false } as {
    kind: string;
    playlist: boolean;
    subscriptionChannels: boolean;
  },
  currentUrl: "",
  animeTrackingSite: false,
  animeTrackingEnabled: false,
};

export function showSubscriptionFields(): void {
  const kind = ($("kind") as HTMLSelectElement).value;
  $("wordsField").hidden = kind !== "wordscan";
  $("rankField").hidden = kind !== "random";
  $("withholdField").hidden = kind !== "withhold";
}

export function fillDatalist(id: string, values: string[]): void {
  const list = $(id) as HTMLDataListElement;
  list.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    list.append(option);
  }
}
