/**
 * WebSocket connection state — badge, status text, and sync.
 * No `any` type permitted.
 */

import { $, send } from "./shared";

export interface ConnectionStateData {
  status: string;
  reason: string;
}

export function setConnection(state: string, text: string): void {
  $("connection").dataset.state = state;
  $("connectionText").textContent = text;
}

export function applyConnectionState(data: ConnectionStateData): void {
  const labels: Record<string, [string, string]> = {
    idle: [
      "idle",
      data.reason === "No enabled site open" ? "Open an enabled site" : "Not connected",
    ],
    connected: ["ok", "Connected (WebSocket)"],
    connecting: [
      "loading",
      data.reason === "Reconnecting" ? "Reconnecting…" : "Connecting…",
    ],
    disconnected: ["err", "Disconnected"],
  };
  const labelEntry = (labels[data.status] ?? labels.disconnected) as [string, string];
  const [state, text] = labelEntry;
  setConnection(state, text);
  $("connection").title = data.reason ?? "";
}

export async function syncConnectionStatus(): Promise<void> {
  const response = await send("dreamedia:connectionStatus");
  if (response.ok && response.data) {
    applyConnectionState(response.data as ConnectionStateData);
  }
}

export function listenConnectionChanges(): void {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "dreamedia:connectionStatus") {
      applyConnectionState(message as ConnectionStateData);
    }
  });
}
