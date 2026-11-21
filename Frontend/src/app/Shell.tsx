import { useEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, ListChecks, LogOut, Puzzle, Settings as SettingsIcon, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import BellPanel from "../features/bell/Bell";
import { initials } from "../lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useApp, useWorkspace } from "./state";
import { Toasts } from "./ui";

const MODES = [
  { href: "/", match: ["/", "/notifications"], label: "Feed", title: "Notifications", icon: Bell, key: "1" },
  { href: "/sources", match: ["/sources", "/management"], label: "Manage", title: "Management", icon: SlidersHorizontal, key: "2" },
  { href: "/todo", match: ["/todo", "/track"], label: "Todo", title: "Todo", icon: ListChecks, key: "3" },
  { href: "/trash", match: ["/trash"], label: "Trash", title: "Trashbin", icon: Trash2, key: "4" },
  { href: "/extension", match: ["/extension"], label: "Ext", title: "Extension", icon: Puzzle, key: "5" },
] as const;

const ADMIN_MODE = { href: "/admin", match: ["/admin"], label: "Admin", title: "Admin", icon: ShieldCheck, key: "6" } as const;

export default function Shell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { viewer, logout, toasts, dismissToast } = useApp();
  const workspace = useWorkspace();
  const modes = useMemo(
    () => (viewer?.role === "admin" ? [...MODES, ADMIN_MODE] : [...MODES]),
    [viewer?.role],
  );
  const active = modes.find((mode) => (mode.match as readonly string[]).includes(location)) ?? modes[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const mode = modes.find((item) => item.key === event.key);
      if (mode) {
        event.preventDefault();
        navigate(mode.href);
      }
      if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-search]");
        if (search) {
          event.preventDefault();
          search.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modes, navigate]);

  const subtitle =
    active.label === "Feed"
      ? `${workspace.ytFeed.length} videos · ${workspace.aniEvents.length} anime events`
      : active.label === "Manage"
        ? `${workspace.ytChannels.length} sources · ${workspace.ytDomains.length + workspace.aniDomains.length} categories`
        : active.label === "Ext"
          ? "token · sites · live lane"
          : active.label === "Admin"
            ? "backups · restore · settings · users"
            : `${workspace.ytCards.length} playlists · ${workspace.aniEntries.length} anime`;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Rail */}
      <aside className="flex w-16 flex-col items-center gap-1 border-r bg-card py-4" aria-label="Primary">
        <div className="mb-4 text-lg font-bold tracking-tight">
          d<span className="text-muted-foreground">/</span>m
        </div>
        <nav className="flex flex-1 flex-col items-center gap-1">
          {modes.map((mode) => {
            const Icon = mode.icon;
            const isActive = mode === active;
            return (
              <button
                key={mode.href}
                aria-current={isActive ? "page" : undefined}
                onClick={() => navigate(mode.href)}
                className={cn(
                  "flex w-12 flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-[10px] font-medium transition-colors cursor-pointer",
                  isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{mode.label}</span>
              </button>
            );
          })}
        </nav>
        <Separator className="my-2 w-8" />
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold"
          title={viewer?.username}
        >
          {initials(viewer?.username)}
        </span>
        <button
          onClick={() => void logout()}
          title="Sign out"
          className="mt-1 flex w-12 flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-[10px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground cursor-pointer"
        >
          <LogOut size={16} strokeWidth={1.8} />
          <span>Exit</span>
        </button>
      </aside>

      {/* Workspace */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b px-5">
          <div className="flex items-baseline gap-3">
            <strong className="text-sm font-semibold">{active.title}</strong>
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              graphql live
            </span>
            <BellPanel />
            <button
              onClick={() => navigate("/settings")}
              title="Settings"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <SettingsIcon size={16} strokeWidth={1.8} />
            </button>
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold"
              title={viewer?.username}
            >
              {initials(viewer?.username)}
            </span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-5">{children}</main>
      </div>

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
