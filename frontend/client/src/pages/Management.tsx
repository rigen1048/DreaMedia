import { useState, type FormEvent } from "react";
import { Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useMedia, type ManagedChannel } from "../data/MediaContext";
import type { SubscribeInput, YtKind } from "../lib/api";

type Tab = "channels" | "categories" | "inactive";
const frequencyOptions = [["day", "Daily"], ["tri_day", "Every 3 days"], ["week", "Weekly"], ["bi_week", "Every 2 weeks"], ["month", "Monthly"], ["bi_month", "Every 2 months"], ["quarter", "Quarterly"], ["half_year", "Every 6 months"], ["year", "Yearly"]] as const;
const getChannelId = (value: string) => {
  const raw = value.trim();
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(raw)) return raw;
  try { const url = new URL(raw); const match = url.pathname.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/); return match?.[1] ?? null; } catch { return null; }
};
const friendlyName = (value: string) => {
  try { const url = new URL(value); return url.pathname.match(/@[^/]+/)?.[0] ?? url.pathname.split("/").filter(Boolean).pop() ?? value; } catch { return value; }
};
const buildInput = (kind: YtKind, link: string, words: string, rank: string): SubscribeInput => {
  const raw = link.trim();
  if (kind === "playlist") {
    let playlistId = raw;
    try { playlistId = new URL(raw).searchParams.get("list") ?? ""; } catch { /* raw list ID is supported by the existing API */ }
    if (!playlistId) throw new Error("Paste a playlist URL containing a list ID, or paste the raw playlist ID required by the current backend.");
    return { kind, link: playlistId, channel_name: `Playlist ${playlistId}`, channel_url: raw, rank };
  }
  if (kind === "tracking" || kind === "wordscan") {
    const channelId = getChannelId(raw);
    if (!channelId) throw new Error("The current backend requires a YouTube channel ID (UC…). It cannot resolve @handle URLs yet; see BACKEND_TODO.md.");
    return { kind, link: channelId, channel_name: friendlyName(raw), channel_url: raw, words: kind === "wordscan" ? words.split(",").map((word) => word.trim()).filter(Boolean) : undefined, rank };
  }
  return { kind, link: raw, channel_name: friendlyName(raw), channel_url: raw, rank };
};

function ChannelRow({ channel, onError }: { channel: ManagedChannel; onError: (message: string) => void }) {
  const { categories, setChannelLabel, assignChannel, deleteChannel, subscribeYoutube } = useMedia();
  const [label, setLabel] = useState(channel.label);
  const [note, setNote] = useState(channel.note);
  const [domain, setDomain] = useState(channel.domain === "uncategorized" ? "" : channel.domain);
  const [subdomain, setSubdomain] = useState(channel.subdomain === "uncategorized" ? "" : channel.subdomain);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [kind, setKind] = useState<YtKind>(channel.kind ?? "tracking");
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const canEditType = channel.kind === "tracking" || channel.kind === "wordscan";
  const categoryDomains = [...new Set(categories.map((item) => item.domain))];
  const run = async (action: () => Promise<void>) => { setBusy(true); onError(""); try { await action(); } catch (error) { onError(error instanceof Error ? error.message : "Backend update failed."); } finally { setBusy(false); } };
  const saveType = () => run(async () => {
    if (!channel.rssId) throw new Error("The backend did not return a channel ID, so this subscription cannot be safely updated.");
    if (kind === "wordscan" && !words.split(",").some((word) => word.trim())) throw new Error("Enter at least one Wordscan term before updating this subscription.");
    const data: SubscribeInput = { kind, link: channel.rssId, channel_name: channel.name, channel_url: channel.url, words: kind === "wordscan" ? words.split(",").map((word) => word.trim()).filter(Boolean) : undefined };
    await subscribeYoutube(data);
    setConfigureOpen(false);
  });
  const saveCategory = () => run(() => assignChannel(channel.id, domain.trim() || "uncategorized", subdomain.trim() || null));
  const saveLabel = (nextLabel: ManagedChannel["label"]) => { setLabel(nextLabel); void run(() => setChannelLabel(channel.id, nextLabel, note)); };
  return <article className="managed-source"><div className="managed-source-main"><div className="managed-source-identity"><span className="managed-source-glyph">{channel.name.slice(0, 1).toUpperCase()}</span><span><strong>{channel.name}</strong><small title={channel.url}>{channel.url}</small></span></div><div className="managed-source-settings"><span className="managed-tag">{channel.mode === "Unknown" ? "Type not exposed" : channel.mode}</span><span className="managed-category">{channel.domain} / {channel.subdomain}</span></div><div className="managed-source-actions"><select aria-label={`Label ${channel.name}`} value={label} onChange={(event) => saveLabel(event.target.value as ManagedChannel["label"])}><option value="none">None</option><option value="reserved">Reserved</option><option value="blocked">Blocked</option></select><button className="quiet-action" onClick={() => setConfigureOpen((value) => !value)}>Configure</button><button className="icon-button small-icon" aria-label={`Delete ${channel.name}`} onClick={() => { if (window.confirm(`Delete ${channel.name} and its stored feed data?`)) void run(() => deleteChannel(channel.id)); }}><Trash2 size={14} /></button></div></div>
    {label !== "none" && <div className="managed-note-row"><label>Label note<input value={note} onChange={(event) => setNote(event.target.value)} onBlur={() => void run(() => setChannelLabel(channel.id, label, note))} placeholder="Optional note" /></label></div>}
    {configureOpen && <div className="source-editor"><p className="api-capability-note">The existing API only safely supports Track ↔ Wordscan changes for rows with a returned channel ID. Other mode edits await backend support.</p>{canEditType ? <><label>Mode<select value={kind} onChange={(event) => setKind(event.target.value as YtKind)}><option value="tracking">Track</option><option value="wordscan">Wordscan</option></select></label>{kind === "wordscan" && <label>Words<input value={words} onChange={(event) => setWords(event.target.value)} placeholder="one word or comma-separated" /></label>}<button className="primary-button small-primary" disabled={busy} onClick={saveType}>{busy ? "Saving…" : "Save type"}</button></> : <span className="muted-status">Mode update unavailable for this backend response.</span>}</div>}
    <div className="managed-source-meta"><label>Domain<input list={`domains-${channel.id}`} value={domain} onChange={(event) => setDomain(event.target.value)} /><datalist id={`domains-${channel.id}`}>{categoryDomains.map((item) => <option key={item} value={item} />)}</datalist></label><label>Subdomain<input list={`subdomains-${channel.id}`} value={subdomain} onChange={(event) => setSubdomain(event.target.value)} /><datalist id={`subdomains-${channel.id}`}>{categories.filter((item) => item.domain === domain).map((item) => <option key={item.id} value={item.subdomain} />)}</datalist></label><button className="quiet-action" disabled={busy || !domain.trim()} onClick={saveCategory}>Assign category</button></div>
  </article>;
}

export default function Management() {
  const { channels, categories, subscribeYoutube, setCategoryActive, refresh } = useMedia();
  const [tab, setTab] = useState<Tab>("channels");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newLink, setNewLink] = useState("");
  const [newMode, setNewMode] = useState<YtKind>("tracking");
  const [newWords, setNewWords] = useState("");
  const [newRank, setNewRank] = useState("week");
  const [newDomain, setNewDomain] = useState("");
  const [newSubdomain, setNewSubdomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const domains = [...new Set(categories.map((category) => category.domain))];
  const shownChannels = channels.filter((channel) => tab === "inactive" ? channel.label !== "none" : channel.label === "none").filter((channel) => `${channel.name} ${channel.url} ${channel.domain} ${channel.subdomain}`.toLowerCase().includes(search.toLowerCase()));
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Backend update failed."); } finally { setBusy(false); } };
  const addSource = async (event: FormEvent) => { event.preventDefault(); await run(async () => { const input = buildInput(newMode, newLink, newWords, newRank); await subscribeYoutube(input, newDomain.trim() ? { domain: newDomain.trim(), subdomain: newSubdomain.trim() || null } : undefined); setNewLink(""); setNewWords(""); setAddOpen(false); }); };
  const unusableCategories = categories.filter((category) => !category.active);

  return <div className="page-content management-page minimal-page"><div className="page-heading-row minimal-heading"><div><span className="page-kicker">MODE 02</span><h1>Management</h1></div><div className="heading-right"><button className="outline-button" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button><button className="primary-button" onClick={() => setAddOpen((value) => !value)}><Plus size={15} /> Add source</button></div></div>
    <div className="management-tabs compact-tabs"><button className={tab === "channels" ? "active" : ""} onClick={() => setTab("channels")}>Channels <span>{channels.filter((channel) => channel.label === "none").length}</span></button><button className={tab === "categories" ? "active" : ""} onClick={() => setTab("categories")}>Domains <span>{domains.length}</span></button><button className={tab === "inactive" ? "active" : ""} onClick={() => setTab("inactive")}>Inactive / labels <span>{channels.filter((channel) => channel.label !== "none").length + unusableCategories.length}</span></button></div>
    {error && <div className="inline-api-error" role="alert">{error}</div>}
    {addOpen && <form className="add-source-form" onSubmit={addSource}><div className="form-heading"><strong>Add YouTube source</strong><span>Only the current backend contract is used. Handle URL resolution is listed in BACKEND_TODO.md.</span></div><label>Channel or playlist link<input autoFocus required value={newLink} onChange={(event) => setNewLink(event.target.value)} placeholder="https://www.youtube.com/channel/UC…" /></label><label>Mode<select value={newMode} onChange={(event) => setNewMode(event.target.value as YtKind)}><option value="tracking">Track</option><option value="wordscan">Wordscan</option><option value="playlist">Playlist</option><option value="random">Random</option></select></label>{newMode === "wordscan" && <label>Words<input value={newWords} onChange={(event) => setNewWords(event.target.value)} placeholder="one word or comma-separated" /></label>}{newMode === "random" && <label>Frequency<select value={newRank} onChange={(event) => setNewRank(event.target.value)}>{frequencyOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<label>Domain (optional)<input list="all-domains" value={newDomain} onChange={(event) => setNewDomain(event.target.value)} placeholder="Assign after adding" /><datalist id="all-domains">{domains.map((domain) => <option key={domain} value={domain} />)}</datalist></label><label>Subdomain (optional)<input value={newSubdomain} onChange={(event) => setNewSubdomain(event.target.value)} placeholder="Create by assigning" /></label><div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? "Sending…" : "Add through backend"}</button><button className="quiet-action" type="button" onClick={() => setAddOpen(false)}>Cancel</button></div></form>}
    {tab === "channels" && <section className="management-panel compact-panel"><div className="panel-heading"><h2>Channels <span className="panel-count">{shownChannels.length}</span></h2><label className="table-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a channel /" /></label></div><div className="api-capability-note">The current API exposes labels and category activation, but not a separate channel active toggle or safe type-switch endpoint.</div><div className="management-list">{shownChannels.map((channel) => <ChannelRow key={channel.id} channel={channel} onError={setError} />)}{shownChannels.length === 0 && <div className="minimal-empty">No channels returned by the backend.</div>}</div></section>}
    {tab === "categories" && <section className="management-panel compact-panel"><div className="panel-heading"><h2>Domains / subdomains <span className="panel-count">{categories.length}</span></h2></div><div className="api-capability-note">Categories are read from the backend sidebar. Assigning a channel can create a category; standalone category add, rename and delete are not exposed by the current API.</div><div className="category-admin-list">{domains.map((domain) => { const children = categories.filter((category) => category.domain === domain); const domainActive = children.some((category) => category.active); return <div className="category-admin-group" key={domain}><div className="category-admin-domain"><strong>{domain}</strong><button className={`active-toggle ${domainActive ? "on" : ""}`} onClick={() => void run(() => setCategoryActive(domain, null, !domainActive))}>{domainActive ? "Active" : "Inactive"}</button></div>{children.map((category) => <div className="category-admin-sub" key={category.id}><span>{category.subdomain}</span><button className={`active-toggle ${category.active ? "on" : ""}`} onClick={() => void run(() => setCategoryActive(domain, category.subdomain, !category.active))}>{category.active ? "Active" : "Inactive"}</button></div>)}</div>; })}{categories.length === 0 && <div className="minimal-empty">No configured categories returned by the backend.</div>}</div></section>}
    {tab === "inactive" && <section className="management-panel compact-panel"><div className="panel-heading"><h2>Reserved / blocked</h2></div><div className="management-list">{channels.filter((channel) => channel.label !== "none").map((channel) => <ChannelRow key={channel.id} channel={channel} onError={setError} />)}{unusableCategories.map((category) => <div className="inactive-category-row" key={category.id}><span>{category.domain} / {category.subdomain}</span><span className="muted-status">Inactive</span><button className="quiet-action" onClick={() => void run(() => setCategoryActive(category.domain, category.subdomain, true))}>Restore</button></div>)}{channels.filter((channel) => channel.label !== "none").length + unusableCategories.length === 0 && <div className="minimal-empty">No reserved, blocked or inactive category records.</div>}</div></section>}
  </div>;
}
