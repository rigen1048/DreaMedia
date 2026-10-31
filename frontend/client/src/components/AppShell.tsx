import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, Command, LayoutList, LogOut, Search, Settings2, X } from "lucide-react";
import { useMedia } from "../data/MediaContext";

const modes = [
  { href: "/notifications", label: "Notifications", key: "1", icon: Bell },
  { href: "/management", label: "Management", key: "2", icon: Settings2 },
  { href: "/track", label: "Todo", key: "3", icon: LayoutList },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [trayOpen, setTrayOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [switcherIndex, setSwitcherIndex] = useState(0);
  const { notifications, logout, syncError, refresh } = useMedia();
  const unreadCount = notifications.filter((item) => item.unread).length;
  const activeMode = location.startsWith("/management") ? "Management" : location.startsWith("/track") ? "Todo" : "Notifications";
  const options = useMemo(() => modes.filter((mode) => mode.label.toLowerCase().includes(switcherQuery.toLowerCase())), [switcherQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSwitcherOpen((open) => !open); setTrayOpen(false); setSwitcherQuery(""); setSwitcherIndex(0); return; }
      if (event.key === "Escape") { setSwitcherOpen(false); setTrayOpen(false); return; }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const mode = modes.find((item) => item.key === event.key);
      if (mode) { setLocation(mode.href); setTrayOpen(false); }
      if (event.key === "/") { event.preventDefault(); window.dispatchEvent(new Event("dreamedia:focus-search")); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setLocation]);

  const navigate = (href: string) => { setLocation(href); setSwitcherOpen(false); setTrayOpen(false); setSwitcherIndex(0); };
  const openNotification = (id: string) => {
    const item = notifications.find((notice) => notice.id === id);
    setTrayOpen(false);
    if (item?.source === "youtube") setLocation(`/track?source=youtube&item=${encodeURIComponent(item.creator)}`);
    else setLocation("/track?source=ani");
  };

  return <div className="app-frame">
    <header className="topbar mode-topbar"><a href="/notifications" className="brand-lockup" aria-label="DreaMedia home"><span className="brand-mark"><span /></span><span className="brand-word">drea<span>/</span>media</span></a>
      <nav className="mode-nav" aria-label="Main modes">{modes.map(({ href, label, key, icon: Icon }) => <button key={href} className={`mode-nav-item ${activeMode === label ? "active" : ""}`} onClick={() => navigate(href)} aria-current={activeMode === label ? "page" : undefined}><Icon size={15} strokeWidth={1.8} /><span>{label}</span><kbd>{key}</kbd></button>)}</nav>
      <div className="topbar-actions"><button className="quick-switch-button" onClick={() => { setSwitcherOpen(true); setSwitcherQuery(""); setSwitcherIndex(0); }} aria-label="Quick switch"><Command size={14} /><span>Jump to</span><kbd>⌘/Ctrl K</kbd></button>
        <div className="notification-anchor"><button className={`bell-button ${trayOpen ? "bell-open" : ""}`} aria-label={`Notifications${unreadCount ? `, ${unreadCount} unseen` : ""}`} aria-expanded={trayOpen} onClick={() => { setTrayOpen(!trayOpen); setSwitcherOpen(false); }}><Bell size={18} strokeWidth={1.8} />{unreadCount > 0 && <span className="bell-count">{unreadCount}</span>}</button>
          {trayOpen && <div className="notification-tray compact-tray"><div className="tray-header"><strong>Recent</strong><button className="icon-button small-icon" aria-label="Close notifications" onClick={() => setTrayOpen(false)}><X size={15} /></button></div><div className="tray-list">{notifications.slice(0, 5).map((item) => <button key={item.id} className={`tray-item ${item.unread ? "is-unread" : ""}`} onClick={() => openNotification(item.id)}><span className={`source-dot ${item.source === "ani" ? "ani-dot" : "yt-dot"}`} /><span className="tray-copy"><strong>{item.creator}</strong><span>{item.title}</span><small>{item.time}</small></span>{item.unread && <span className="unread-dot" />}</button>)}</div><div className="tray-footer"><span>Synced from backend</span><button className="tray-view-all" onClick={() => navigate("/notifications")}>Inbox <span>{unreadCount}</span></button></div></div>}
        </div><button className="topbar-avatar" aria-label="Sign out" title="Sign out" onClick={() => void logout()}><LogOut size={13} /></button>
      </div>
    </header>
    {syncError && <div className="backend-sync-status" role="status"><span>Sync paused · {syncError}</span><button onClick={() => void refresh()}>Retry</button></div>}
    <main className="page-canvas">{children}</main>
    {switcherOpen && <div className="switcher-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setSwitcherOpen(false); }}><section className="mode-switcher" role="dialog" aria-modal="true" aria-label="Jump to mode"><div className="switcher-search"><Search size={16} /><input autoFocus value={switcherQuery} onChange={(event) => { setSwitcherQuery(event.target.value); setSwitcherIndex(0); }} placeholder="Go to a mode…" onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setSwitcherIndex((index) => Math.min(index + 1, Math.max(0, options.length - 1))); } if (event.key === "ArrowUp") { event.preventDefault(); setSwitcherIndex((index) => Math.max(index - 1, 0)); } if (event.key === "Enter" && options[switcherIndex]) navigate(options[switcherIndex].href); }} /><kbd>ESC</kbd></div><div className="switcher-label">MODES</div>{options.map(({ href, label, key, icon: Icon }, index) => <button key={href} className={`switcher-option ${activeMode === label ? "current" : ""} ${switcherIndex === index ? "selected" : ""}`} onMouseEnter={() => setSwitcherIndex(index)} onClick={() => navigate(href)}><Icon size={16} /><span>{label}</span>{activeMode === label && <small>Current</small>}<kbd>{key}</kbd></button>)}<div className="switcher-foot"><span>↑↓ Select</span><span>↵ Open</span><span>/ Search</span></div></section></div>}
  </div>;
}
