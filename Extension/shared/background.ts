/**
 * DreaMedia Extension — Background Service Worker Entry Point
 *
 * The ONLY network lane for the extension — content/popup scripts never
 * fetch directly. It owns dynamic content-script registration: modules
 * load ONLY on domains from the user's allowlist (ext_domains), never on
 * arbitrary pages.
 *
 * Imports and initialises all Media/Yt, Media/Ani, shared automation and
 * shared core layers. No `any` type permitted.
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
import { ytManager } from "../Media/Yt/manager";
import { aniManager } from "../Media/Ani/manager";

// Register all built-in automations
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

// ── Background service worker lifecycle ──────────────────────────────

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

// ── Initialise media managers ────────────────────────────────────────

void ytManager.initialize();
void aniManager.initialize();

// ── Initial automation run ───────────────────────────────────────────

void automation.runAllForEvent("lifecycle:startup");
