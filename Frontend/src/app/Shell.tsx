import { useEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, ListChecks, LogOut, ShieldCheck, SlidersHorizontal } from "lucide-react";
import BellPanel from "../features/bell/Bell";
import { initials } from "../lib/format";
import { useApp, useWorkspace } from "./state";
import { Toasts } from "./ui";

const MODES = [
  {
    href: "/",
    match: ["/", "/notifications"],
    label: "Feed",
    title: "Notifications",
    icon: Bell,
    key: "1",
  },
  {
    href: "/sources",
    match: ["/sources", "/management"],
    label: "Manage",
    title: "Management",
    icon: SlidersHorizontal,
    key: "2",
  },
  {
    href: "/todo",
    match: ["/todo", "/track"],
    label: "Todo",
    title: "Todo",
    icon: ListChecks,
    key: "3",
  },
];

/** Admin is not a mode for everyone: it only exists for the admin role. */
const ADMIN_MODE = {
  href: "/admin",
  match: ["/admin"],
  label: "Admin",
  title: "Admin",
  icon: ShieldCheck,
  key: "4",
};

export default function Shell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { viewer, logout, toasts, dismissToast } = useApp();
  const workspace = useWorkspace();
  const modes = useMemo(
    () => (viewer?.role === "admin" ? [...MODES, ADMIN_MODE] : MODES),
    [viewer?.role],
  );
  const active = modes.find((mode) => mode.match.includes(location)) ?? modes[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (typing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
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
        : active.label === "Admin"
        ? "backups · restore · settings · users"
        : `${workspace.ytCards.length} playlists · ${workspace.aniEntries.length} anime`;

  return (
    <div className="app">
      <aside className="rail" aria-label="Primary">
        <div className="rail__brand" title="DreaMedia">
          d<span>/</span>m
        </div>
        <nav className="rail__nav">
          {modes.map((mode) => {
            const Icon = mode.icon;
            const isActive = mode === active;
            return (
              <button
                key={mode.href}
                className="rail__item"
                data-active={isActive}
                aria-current={isActive ? "page" : undefined}
                onClick={() => navigate(mode.href)}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{mode.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="rail__foot">
          <span className="rail__avatar" title={viewer?.username}>
            {initials(viewer?.username)}
          </span>
          <button className="rail__item" onClick={() => void logout()} title="Sign out">
            <LogOut size={16} strokeWidth={1.8} />
            <span>Exit</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__mode">
            <strong>{active.title}</strong>
            <span>{subtitle}</span>
          </div>
          <div className="topbar__actions">
            <span className="sync-state" data-error={false}>
              <span className="pulse" />
              graphql live
            </span>
            <BellPanel />
            <span className="rail__avatar" title={viewer?.username}>
              {initials(viewer?.username)}
            </span>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
