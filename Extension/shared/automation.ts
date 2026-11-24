/**
 * DreaMedia Extension — Automation Registry
 *
 * Makes the implicit automation that shows up in the extension based on
 * events EXPLICIT. Every event-driven automation is registered here with
 * a clear description of what triggers it and what it does.
 *
 * No `any` type permitted.
 */

import type { ConnectionState } from "../Media/Yt/Config/Model/types";

/**
 * Describes a single registered automation.
 */
export interface AutomationRegistration {
  name: string;
  description: string;
  event: string;
  enabled: boolean;
  handler: () => void | Promise<void>;
}

/**
 * The automation registry. All event-driven automations are registered
 * here so the automation surface is explicit and auditable.
 */
export class AutomationRegistry {
  private automations: Map<string, AutomationRegistration> = new Map();
  private running: Set<string> = new Set();

  /**
   * Register a new automation. Throws if a name collision occurs.
   */
  register(automation: AutomationRegistration): void {
    if (this.automations.has(automation.name)) {
      throw new Error(`Automation already registered: ${automation.name}`);
    }
    this.automations.set(automation.name, automation);
  }

  /**
   * Get all registered automations (for inspection/auditing).
   */
  list(): AutomationRegistration[] {
    return [...this.automations.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Enable or disable an automation by name.
   */
  setEnabled(name: string, enabled: boolean): boolean {
    const automation = this.automations.get(name);
    if (!automation) return false;
    automation.enabled = enabled;
    return true;
  }

  /**
   * Check if an automation is enabled.
   */
  isEnabled(name: string): boolean {
    return this.automations.get(name)?.enabled ?? false;
  }

  /**
   * Run an automation by name if it is enabled. Prevents concurrent runs
   * of the same automation.
   */
  async run(name: string): Promise<void> {
    const automation = this.automations.get(name);
    if (!automation) {
      throw new Error(`Unknown automation: ${name}`);
    }
    if (!automation.enabled) return;
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await automation.handler();
    } finally {
      this.running.delete(name);
    }
  }

  /**
   * Run all enabled automations that match a given event name.
   */
  async runAllForEvent(event: string): Promise<void> {
    const matches = this.list().filter((a) => a.event === event && a.enabled);
    await Promise.all(matches.map((a) => this.run(a.name)));
  }
}

export const automation = new AutomationRegistry();

/**
 * Built-in automations. These are the explicit event-driven automations
 * that previously lived implicitly in lifecycle listeners and message
 * handlers.
 */

// ── Automation: Domain refresh on alarm ──────────────────────────────

export function registerDomainRefreshAlarm(
  handler: () => Promise<void>
): void {
  automation.register({
    name: "domain-refresh-alarm",
    description: "Refresh domains and content-script registrations every 5 minutes via chrome.alarms",
    event: "alarm:dreamedia:domains",
    enabled: true,
    handler,
  });
}

// ── Automation: WebSocket watchdog on alarm ──────────────────────────

export function registerWsWatchdogAlarm(
  handler: () => Promise<void>
): void {
  automation.register({
    name: "ws-watchdog-alarm",
    description: "Ensure WebSocket connection is alive every 1 minute via chrome.alarms",
    event: "alarm:dreamedia:ws-watchdog",
    enabled: true,
    handler,
  });
}

// ── Automation: Tab updated → refresh all ────────────────────────────

export function registerTabUpdatedAutomation(
  handler: (url: string | undefined, status: string | undefined) => void
): void {
  automation.register({
    name: "tab-updated-refresh",
    description: "Refresh all extension state when a tab is updated or navigates",
    event: "tab:updated",
    enabled: true,
    handler: () => {
      // Called from chrome.tabs.onUpdated listener with url/status
      void handler(undefined, undefined);
    },
  });
}

// ── Automation: Tab activated → refresh all ──────────────────────────

export function registerTabActivatedAutomation(
  handler: () => void
): void {
  automation.register({
    name: "tab-activated-refresh",
    description: "Refresh all extension state when the active tab changes",
    event: "tab:activated",
    enabled: true,
    handler,
  });
}

// ── Automation: Tab removed → refresh all ────────────────────────────

export function registerTabRemovedAutomation(
  handler: () => void
): void {
  automation.register({
    name: "tab-removed-refresh",
    description: "Refresh all extension state when a tab is closed",
    event: "tab:removed",
    enabled: true,
    handler,
  });
}

// ── Automation: Startup / installed → refresh all ────────────────────

export function registerStartupAutomation(handler: () => void): void {
  automation.register({
    name: "startup-refresh",
    description: "Refresh all extension state on service worker startup or install",
    event: "lifecycle:startup",
    enabled: true,
    handler,
  });
}

// ── Automation: Connection state change → reconnect ──────────────────

export function registerConnectionChangeAutomation(
  handler: (previous: ConnectionState | null, current: ConnectionState) => void
): void {
  automation.register({
    name: "connection-change-reconnect",
    description: "Reconnect WebSocket when backendUrl or token changes in storage",
    event: "storage:connection-change",
    enabled: true,
    handler: () => {
      void handler(null, { status: "idle", reason: "Not configured" });
    },
  });
}

/**
 * Type-safe event names used by the automation registry.
 */
export type AutomationEvent =
  | "alarm:dreamedia:domains"
  | "alarm:dreamedia:ws-watchdog"
  | "tab:updated"
  | "tab:activated"
  | "tab:removed"
  | "lifecycle:startup"
  | "storage:connection-change";
