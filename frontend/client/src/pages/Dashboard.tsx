import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CirclePlay, Search, Youtube } from "lucide-react";
import { useMedia, type MediaNotification, type MediaSource, type NotificationMode } from "../data/MediaContext";

const notificationModes: (NotificationMode | "All")[] = ["All", "Track", "Wordscan", "Playlist", "Random"];
type FilterView = "category" | "subscription";
function NoticeRow({ item, onOpen }: { item: MediaNotification; onOpen: () => void }) {
  return <button className={`signal-row ${item.unread ? "unread" : ""}`} onClick={onOpen}><span className={`signal-indicator ${item.source === "ani" ? "signal-ani" : ""}`} /><span className={`signal-avatar signal-${item.color}`}>{item.creator.slice(0, 1).toUpperCase()}</span><span className="signal-copy"><span className="signal-topline"><strong>{item.creator}</strong><span>{item.time}</span></span><span className="signal-title">{item.title}</span><span className="signal-bottomline"><span>{item.domain}<i>/</i>{item.subdomain}</span><span className={`signal-mode mode-${item.mode.toLowerCase()}`}>{item.mode}</span></span></span><CirclePlay className="signal-open" size={17} /></button>;
}

export default function Dashboard() {
  const [location, setLocation] = useLocation();
  const { notifications, channels, categories, markFeedSeen, refresh } = useMedia();
  const [source, setSource] = useState<MediaSource>("youtube");
  const [filterView, setFilterView] = useState<FilterView>("category");
  const [mode, setMode] = useState<NotificationMode | "All">("All");
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(null);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    if (params.get("source") === "ani") setSource("ani");
    if (params.get("source") === "youtube") setSource("youtube");
  }, [location]);
  useEffect(() => {
    const focusSearch = () => { searchRef.current?.focus(); window.setTimeout(() => { if (searchRef.current?.value === "/") setSearch(""); }, 0); };
    window.addEventListener("dreamedia:focus-search", focusSearch); return () => window.removeEventListener("dreamedia:focus-search", focusSearch);
  }, []);

  const sourceNotices = useMemo(() => notifications.filter((item) => item.source === source), [notifications, source]);
  const activeNotices = source === "youtube" ? sourceNotices.filter((item) => {
    const channel = channels.find((entry) => entry.name.toLowerCase() === item.creator.toLowerCase());
    const category = categories.find((entry) => entry.domain === item.domain && entry.subdomain === item.subdomain);
    return channel?.label !== "blocked" && channel?.label !== "reserved" && channel?.active !== false && (!category || category.active);
  }) : sourceNotices;
  const categoryBuckets = useMemo(() => {
    const counts = new Map<string, { domain: string; subdomain: string; count: number }>();
    activeNotices.forEach((item) => { const key = `${item.domain}::${item.subdomain}`; const existing = counts.get(key); if (existing) existing.count += 1; else counts.set(key, { domain: item.domain, subdomain: item.subdomain, count: 1 }); });
    return [...counts.values()];
  }, [activeNotices]);
  const domains = [...new Set(categoryBuckets.map((item) => item.domain))];
  const subdomainsForDomain = (domain: string) => categoryBuckets.filter((item) => item.domain === domain);
  const hasCategoryFilter = source === "youtube" && categoryBuckets.length > 1;
  const filtered = activeNotices.filter((item) => {
    if (source === "youtube" && filterView === "subscription" && mode !== "All" && item.mode !== mode) return false;
    if (source === "youtube" && filterView === "category" && selectedDomain && item.domain !== selectedDomain) return false;
    if (source === "youtube" && filterView === "category" && selectedSubdomain && item.subdomain !== selectedSubdomain) return false;
    if (unreadOnly && !item.unread) return false;
    return !search || `${item.creator} ${item.title} ${item.domain} ${item.subdomain} ${item.mode}`.toLowerCase().includes(search.toLowerCase());
  });
  const unreadVisible = filtered.filter((item) => item.unread);
  const open = async (item: MediaNotification) => {
    setError("");
    try { if (item.unread) await markFeedSeen([item]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update seen state."); return; }
    setLocation(item.source === "youtube" ? `/track?source=youtube&item=${encodeURIComponent(item.creator)}` : `/track?source=ani&item=${encodeURIComponent(item.creator)}`);
  };
  const markVisible = async () => { setError(""); try { await markFeedSeen(unreadVisible); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update seen state."); } };
  const chooseDomain = (domain: string | null) => { setSelectedDomain(domain); setSelectedSubdomain(null); };

  return <div className="page-content minimal-page notifications-page"><div className="minimal-heading"><div><span className="page-kicker">MODE 01</span><h1>Notifications</h1></div><div className="heading-metrics"><span>{filtered.length} shown</span><span className="metric-divider" /><span>{activeNotices.filter((item) => item.unread).length} unseen</span></div></div>
    <div className="notification-controls"><div className="source-switch" role="tablist" aria-label="Notification source"><button className={source === "youtube" ? "active" : ""} aria-selected={source === "youtube"} onClick={() => { setSource("youtube"); setSelectedDomain(null); setSelectedSubdomain(null); }}><Youtube size={14} /> YouTube <span>{notifications.filter((item) => item.source === "youtube").length}</span></button><button className={source === "ani" ? "active" : ""} aria-selected={source === "ani"} onClick={() => { setSource("ani"); setSelectedDomain(null); setSelectedSubdomain(null); }}><span className="ani-mark">あ</span> Ani <span>{notifications.filter((item) => item.source === "ani").length}</span></button></div><label className="minimal-search"><Search size={15} /><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" /><kbd>/</kbd></label></div>
    {source === "youtube" && <div className="filter-switch-row"><div className="filter-switch" aria-label="Filter type"><button className={filterView === "category" ? "active" : ""} onClick={() => { setFilterView("category"); setSelectedDomain(null); setSelectedSubdomain(null); }}>Domain / subdomain</button><button className={filterView === "subscription" ? "active" : ""} onClick={() => { setFilterView("subscription"); setSelectedDomain(null); setSelectedSubdomain(null); }}>Subscription type</button></div><button className={`unread-filter ${unreadOnly ? "active" : ""}`} onClick={() => setUnreadOnly((value) => !value)}><span />Unseen</button></div>}
    {source === "youtube" && filterView === "category" && hasCategoryFilter && <div className="category-filter-area">{domains.length > 1 ? <div className="domain-filter-list"><button className={`domain-filter ${!selectedDomain ? "active" : ""}`} onClick={() => chooseDomain(null)}><span>All</span><b>{activeNotices.length}</b></button>{domains.map((domain) => <div className="domain-filter-group" key={domain}><button className={`domain-filter ${selectedDomain === domain && !selectedSubdomain ? "active" : ""}`} onClick={() => chooseDomain(selectedDomain === domain && !selectedSubdomain ? null : domain)}><span>{domain}</span><b>{subdomainsForDomain(domain).reduce((sum, item) => sum + item.count, 0)}</b></button>{subdomainsForDomain(domain).map((item) => <button key={item.subdomain} className={`subdomain-filter ${selectedDomain === domain && selectedSubdomain === item.subdomain ? "active" : ""}`} onClick={() => { setSelectedDomain(domain); setSelectedSubdomain(selectedSubdomain === item.subdomain ? null : item.subdomain); }}><span>{item.subdomain}</span><b>{item.count}</b></button>)}</div>)}</div> : <div className="subdomain-filter-list"><button className={`subdomain-filter ${!selectedSubdomain ? "active" : ""}`} onClick={() => setSelectedSubdomain(null)}>All</button>{categoryBuckets.map((item) => <button key={item.subdomain} className={`subdomain-filter ${selectedSubdomain === item.subdomain ? "active" : ""}`} onClick={() => setSelectedSubdomain(selectedSubdomain === item.subdomain ? null : item.subdomain)}><span>{item.subdomain}</span><b>{item.count}</b></button>)}</div>}</div>}
    {source === "youtube" && filterView === "subscription" && <div className="subscription-filter-list">{notificationModes.map((item) => <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item}<span>{item === "All" ? activeNotices.length : activeNotices.filter((notice) => notice.mode === item).length}</span></button>)}</div>}
    {source === "youtube" && filterView === "category" && !hasCategoryFilter && categoryBuckets.length === 1 && <div className="single-category-label"><span>{categoryBuckets[0].domain}</span><span>/</span><strong>{categoryBuckets[0].subdomain}</strong></div>}
    {error && <div className="inline-api-error" role="alert">{error}</div>}
    <div className="signal-list-header"><span>{source === "youtube" ? "RECENT" : "ANI EVENTS"}</span><div><button onClick={() => void refresh()}>Refresh</button>{unreadVisible.length > 0 && <button onClick={() => void markVisible()}>Mark visible seen · {unreadVisible.length}</button>}</div></div><div className="signal-list">{filtered.length ? filtered.map((item) => <NoticeRow key={item.id} item={item} onOpen={() => void open(item)} />) : <div className="minimal-empty">No backend items match.</div>}</div><div className="keyboard-hint"><span><kbd>1</kbd> Notifications</span><span><kbd>2</kbd> Management</span><span><kbd>3</kbd> Todo</span><button onClick={() => void refresh()}>Refresh</button></div>
  </div>;
}
