import { Bell, LayoutList, Settings2, type LucideIcon } from "lucide-react";

export type AppMode = "Notifications" | "Management" | "Todo";

export type AppModeDefinition = {
  href: string;
  label: AppMode;
  key: string;
  icon: LucideIcon;
};

export const appModes: AppModeDefinition[] = [
  { href: "/notifications", label: "Notifications", key: "1", icon: Bell },
  { href: "/management", label: "Management", key: "2", icon: Settings2 },
  { href: "/track", label: "Todo", key: "3", icon: LayoutList },
];

export function getActiveMode(location: string): AppMode {
  if (location.startsWith("/management")) return "Management";
  if (location.startsWith("/track")) return "Todo";
  return "Notifications";
}
