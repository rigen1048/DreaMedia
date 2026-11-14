import { useState } from "react";
import { BellOff, BellRing, Pencil, Plus, Trash2, X } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { ConfirmButton, MiniSwitch } from "../../app/ui";
import type { Domain } from "../../lib/types";

type Kind = "yt" | "ani";

export default function Categories() {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <CategorySection
        kind="yt"
        title="YouTube categories"
        hint="Domains group channels; subdomains attach to channels."
      />
      <CategorySection
        kind="ani"
        title="Anime categories"
        hint="Used by Management and the notification filter rail."
      />
    </div>
  );
}

function CategorySection({ kind, title, hint }: { kind: Kind; title: string; hint: string }) {
  const workspace = useWorkspace();
  const { act } = useApp();
  const domains = kind === "yt" ? workspace.ytDomains : workspace.aniDomains;
  const [newDomain, setNewDomain] = useState("");

  const createDomain = () =>
    kind === "yt" ? api.ytCreateDomain(newDomain.trim()) : api.aniCreateDomain(newDomain.trim());

  return (
    <section>
      <div className="section-head">
        <h2>{title}</h2>
        <span>{hint}</span>
        <span className="grow" />
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            style={{ width: 180, height: 30, fontSize: 12 }}
            value={newDomain}
            onChange={(event) => setNewDomain(event.target.value)}
            placeholder="New domain"
            onKeyDown={(event) => {
              if (event.key === "Enter" && newDomain.trim()) {
                void act(createDomain, "Domain created").then(() => setNewDomain(""));
              }
            }}
          />
          <button
            className="btn btn--sm"
            disabled={!newDomain.trim()}
            onClick={() => void act(createDomain, "Domain created").then(() => setNewDomain(""))}
          >
            <Plus size={13} /> Domain
          </button>
        </div>
      </div>

      <div className="domain-grid">
        {domains.map((domain) => (
          <DomainCard key={domain.id} kind={kind} domain={domain} />
        ))}
        {domains.length === 0 && (
          <div className="panel" style={{ padding: 18, color: "var(--faint)", fontSize: 12 }}>
            No categories yet. Create one above, then attach channels or anime to it.
          </div>
        )}
      </div>
    </section>
  );
}

function DomainCard({ kind, domain }: { kind: Kind; domain: Domain }) {
  const { act } = useApp();
  const [editing, setEditing] = useState<null | {
    id: number;
    type: "domain" | "sub";
    value: string;
  }>(null);
  const [newSub, setNewSub] = useState("");

  const rename = (id: number, type: "domain" | "sub", name: string) => {
    if (type === "domain") {
      return kind === "yt" ? api.ytRenameDomain(id, name) : api.aniRenameDomain(id, name);
    }
    return kind === "yt" ? api.ytRenameSubdomain(id, name) : api.aniRenameSubdomain(id, name);
  };

  const setNotify = (id: number, type: "domain" | "sub", notify: boolean) => {
    if (type === "domain") {
      return kind === "yt" ? api.ytSetDomainNotify(id, notify) : api.aniSetDomainNotify(id, notify);
    }
    return kind === "yt"
      ? api.ytSetSubdomainNotify(id, notify)
      : api.aniSetSubdomainNotify(id, notify);
  };

  const remove = (id: number, type: "domain" | "sub") => {
    if (type === "domain") {
      return kind === "yt" ? api.ytDeleteDomain(id) : api.aniDeleteDomain(id);
    }
    return kind === "yt" ? api.ytDeleteSubdomain(id) : api.aniDeleteSubdomain(id);
  };

  const addSub = () =>
    kind === "yt"
      ? api.ytCreateSubdomain(domain.id, newSub.trim())
      : api.aniCreateSubdomain(domain.id, newSub.trim());

  const beginEdit = (id: number, type: "domain" | "sub", value: string) =>
    setEditing({ id, type, value });

  const submitEdit = () => {
    if (!editing || !editing.value.trim()) return;
    void act(() => rename(editing.id, editing.type, editing.value.trim()), "Renamed").then(() =>
      setEditing(null),
    );
  };

  return (
    <div className="domain-card">
      <div className="domain-card__head">
        <span
          className="domain-card__name"
          style={{ color: domain.notify ? "var(--text)" : "var(--faint)" }}
          title={domain.notify ? "Notifications on" : "Notifications muted"}
        >
          {editing?.type === "domain" && editing.id === domain.id ? (
            <input
              className="input"
              style={{ height: 26, fontSize: 12, width: 160 }}
              autoFocus
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitEdit();
                if (event.key === "Escape") setEditing(null);
              }}
              onBlur={submitEdit}
            />
          ) : (
            domain.name
          )}
        </span>
        <span className="domain-card__count">{domain.channelCount ?? 0}</span>
        <span className="grow" />
        <button
          className="icon-btn"
          title={domain.notify ? "Mute entire domain" : "Unmute domain"}
          aria-label={domain.notify ? "Mute entire domain" : "Unmute domain"}
          onClick={() => void act(() => setNotify(domain.id, "domain", !domain.notify))}
        >
          {domain.notify ? (
            <BellRing size={13} />
          ) : (
            <BellOff size={13} style={{ color: "var(--faint)" }} />
          )}
        </button>
        <button
          className="icon-btn"
          aria-label="Rename domain"
          title="Rename domain"
          onClick={() => beginEdit(domain.id, "domain", domain.name)}
        >
          <Pencil size={12} />
        </button>
        <ConfirmButton
          label={`Delete ${domain.name}`}
          onConfirm={() => void act(() => remove(domain.id, "domain"), "Domain deleted")}
        >
          <Trash2 size={12} />
        </ConfirmButton>
      </div>

      <div className="domain-card__body">
        {domain.subdomains.map((sub) => (
          <div className="sub-row" key={sub.id}>
            {editing?.type === "sub" && editing.id === sub.id ? (
              <input
                className="input"
                style={{ height: 24, fontSize: 11.5, width: 150 }}
                autoFocus
                value={editing.value}
                onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitEdit();
                  if (event.key === "Escape") setEditing(null);
                }}
                onBlur={submitEdit}
              />
            ) : (
              <span style={{ color: sub.notify ? "var(--dim)" : "var(--faint)" }}>{sub.name}</span>
            )}
            <span className="count">{sub.channelCount}</span>
            <span className="grow" />
            <MiniSwitch
              checked={sub.notify}
              label={`Notify for ${sub.name}`}
              onChange={(next) => void act(() => setNotify(sub.id, "sub", next))}
            />
            <button
              className="icon-btn"
              style={{ width: 24, height: 24 }}
              aria-label="Rename subdomain"
              onClick={() => beginEdit(sub.id, "sub", sub.name)}
            >
              <Pencil size={11} />
            </button>
            <ConfirmButton
              label={`Delete ${sub.name}`}
              className="icon-btn icon-btn--danger"
              onConfirm={() => void act(() => remove(sub.id, "sub"), "Subdomain deleted")}
            >
              <X size={11} />
            </ConfirmButton>
          </div>
        ))}

        <div className="sub-add">
          <input
            className="input"
            value={newSub}
            onChange={(event) => setNewSub(event.target.value)}
            placeholder="New subdomain"
            onKeyDown={(event) => {
              if (event.key === "Enter" && newSub.trim()) {
                void act(addSub, "Subdomain added").then(() => setNewSub(""));
              }
            }}
          />
          <button
            className="btn btn--sm"
            disabled={!newSub.trim()}
            onClick={() => void act(addSub, "Subdomain added").then(() => setNewSub(""))}
          >
            <Plus size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
