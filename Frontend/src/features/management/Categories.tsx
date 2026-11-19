import { useState } from "react";
import { BellOff, BellRing, Pencil, Plus, Trash2, X } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { ConfirmButton } from "../../app/ui";
import { Switch } from "@/components/ui/switch";
import type { Domain } from "../../lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type Kind = "yt" | "ani";

export default function Categories() {
  return (
    <div className="grid gap-8">
      <CategorySection kind="yt" title="YouTube categories" hint="Domains group channels; subdomains attach to channels." />
      <CategorySection kind="ani" title="Anime categories" hint="Used by Management and the notification filter rail." />
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
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{hint}</span>
        <span className="grow" />
        <Input
          className="h-8 w-44"
          value={newDomain}
          onChange={(event) => setNewDomain(event.target.value)}
          placeholder="New domain"
          onKeyDown={(event) => {
            if (event.key === "Enter" && newDomain.trim()) {
              void act(createDomain, "Domain created").then(() => setNewDomain(""));
            }
          }}
        />
        <Button
          size="sm"
          disabled={!newDomain.trim()}
          onClick={() => void act(createDomain, "Domain created").then(() => setNewDomain(""))}
        >
          <Plus size={13} /> Domain
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {domains.map((domain) => (
          <DomainCard key={domain.id} kind={kind} domain={domain} />
        ))}
        {domains.length === 0 && (
          <Card className="p-5 text-sm text-muted-foreground">
            No categories yet. Create one above, then attach channels or anime to it.
          </Card>
        )}
      </div>
    </section>
  );
}

function DomainCard({ kind, domain }: { kind: Kind; domain: Domain }) {
  const { act } = useApp();
  const [editing, setEditing] = useState<null | { id: number; type: "domain" | "sub"; value: string }>(null);
  const [newSub, setNewSub] = useState("");

  const rename = (id: number, type: "domain" | "sub", name: string) => {
    if (type === "domain") return kind === "yt" ? api.ytRenameDomain(id, name) : api.aniRenameDomain(id, name);
    return kind === "yt" ? api.ytRenameSubdomain(id, name) : api.aniRenameSubdomain(id, name);
  };

  const setNotify = (id: number, type: "domain" | "sub", notify: boolean) => {
    if (type === "domain") return kind === "yt" ? api.ytSetDomainNotify(id, notify) : api.aniSetDomainNotify(id, notify);
    return kind === "yt" ? api.ytSetSubdomainNotify(id, notify) : api.aniSetSubdomainNotify(id, notify);
  };

  const remove = (id: number, type: "domain" | "sub") => {
    if (type === "domain") return kind === "yt" ? api.ytDeleteDomain(id) : api.aniDeleteDomain(id);
    return kind === "yt" ? api.ytDeleteSubdomain(id) : api.aniDeleteSubdomain(id);
  };

  const addSub = () =>
    kind === "yt" ? api.ytCreateSubdomain(domain.id, newSub.trim()) : api.aniCreateSubdomain(domain.id, newSub.trim());

  const beginEdit = (id: number, type: "domain" | "sub", value: string) => setEditing({ id, type, value });

  const submitEdit = () => {
    if (!editing || !editing.value.trim()) return;
    void act(() => rename(editing.id, editing.type, editing.value.trim()), "Renamed").then(() => setEditing(null));
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 p-3">
        {editing?.type === "domain" && editing.id === domain.id ? (
          <Input
            className="h-7 w-40"
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
          <span
            className={cn("truncate text-sm font-semibold", !domain.notify && "text-muted-foreground")}
            title={domain.notify ? "Notifications on" : "Notifications muted"}
          >
            {domain.name}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{domain.channelCount ?? 0}</span>
        <span className="grow" />
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          title={domain.notify ? "Mute entire domain" : "Unmute domain"}
          aria-label={domain.notify ? "Mute entire domain" : "Unmute domain"}
          onClick={() => void act(() => setNotify(domain.id, "domain", !domain.notify))}
        >
          {domain.notify ? <BellRing size={13} /> : <BellOff size={13} className="text-muted-foreground" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Rename domain" title="Rename domain" onClick={() => beginEdit(domain.id, "domain", domain.name)}>
          <Pencil size={12} />
        </Button>
        <ConfirmButton label={`Delete ${domain.name}`} className="h-7 w-7" onConfirm={() => void act(() => remove(domain.id, "domain"), "Domain deleted")}>
          <Trash2 size={12} />
        </ConfirmButton>
      </CardHeader>

      <CardContent className="space-y-1 p-3 pt-0">
        {domain.subdomains.map((sub) => (
          <div key={sub.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/40">
            {editing?.type === "sub" && editing.id === sub.id ? (
              <Input
                className="h-6 w-36 text-xs"
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
              <span className={cn("text-sm", !sub.notify && "text-muted-foreground")}>{sub.name}</span>
            )}
            <span className="text-xs text-muted-foreground">{sub.channelCount}</span>
            <span className="grow" />
            <Switch
              checked={sub.notify}
              aria-label={`Notify for ${sub.name}`}
              onCheckedChange={(next) => void act(() => setNotify(sub.id, "sub", next))}
            />
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Rename subdomain" onClick={() => beginEdit(sub.id, "sub", sub.name)}>
              <Pencil size={11} />
            </Button>
            <ConfirmButton label={`Delete ${sub.name}`} className="h-6 w-6" onConfirm={() => void act(() => remove(sub.id, "sub"), "Subdomain deleted")}>
              <X size={11} />
            </ConfirmButton>
          </div>
        ))}

        <div className="flex gap-1.5 pt-1.5">
          <Input
            className="h-7 text-xs"
            value={newSub}
            onChange={(event) => setNewSub(event.target.value)}
            placeholder="New subdomain"
            onKeyDown={(event) => {
              if (event.key === "Enter" && newSub.trim()) {
                void act(addSub, "Subdomain added").then(() => setNewSub(""));
              }
            }}
          />
          <Button size="sm" variant="secondary" className="h-7" disabled={!newSub.trim()} onClick={() => void act(addSub, "Subdomain added").then(() => setNewSub(""))}>
            <Plus size={12} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
