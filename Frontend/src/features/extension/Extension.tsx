import { useEffect, useState } from "react";
import { Copy, Globe, History, KeyRound, Trash2 } from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import type { ExtDomain, ExtLearnedSite } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Extension management: personal token (D55), the sites allowlist that
 * scopes where the extension runs at all (ext v2 phase 1), and the learned
 * watch-site map (phase 5). */
export default function Extension() {
  const { notify, act } = useApp();
  const [token, setToken] = useState<string | null>(null);
  const [domains, setDomains] = useState<ExtDomain[]>([]);
  const [learned, setLearned] = useState<ExtLearnedSite[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [newMedia, setNewMedia] = useState<"ani" | "yt">("ani");

  const loadDomains = async () => {
    try {
      setDomains((await api.extDomains()).extDomains);
    } catch {
      // vault locked or offline — leave the list empty; actions will surface errors
    }
  };
  const loadLearned = async () => {
    try {
      setLearned((await api.extLearnedSites()).extLearnedSites);
    } catch {
      // same vault story as the allowlist
    }
  };
  useEffect(() => {
    void loadDomains();
    void loadLearned();
  }, []);

  const issueToken = async () => {
    const result = await api.extIssueToken();
    setToken(result.extIssueToken);
    notify("Extension token issued — copy it now, it will not be shown again", "ok");
  };

  const addSite = () =>
    void act(async () => {
      await api.extAddDomain(newDomain.trim(), newMedia);
      setNewDomain("");
      await loadDomains();
    }, "Site added — reload its tab to start tracking");

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Extension</h1>
        <p className="text-xs text-muted-foreground">
          The browser extension authenticates with your token and runs only on the sites you allow.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><KeyRound size={14} /> Token</CardTitle>
          <CardDescription>
            The DreaMedia extension (MV3 Chrome / MV2 Firefox) authenticates with a personal token,
            not your session. Issue one here and paste it into the popup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {token && (
            <div className="flex gap-2">
              <Input readOnly value={token} className="font-mono text-xs" />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(token);
                  notify("Token copied", "ok");
                }}
              >
                <Copy size={13} /> Copy
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void issueToken()}>
              Issue new token
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act(() => api.extRevokeToken(), "Extension token revoked")}
            >
              Revoke token
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Issuing a new token replaces the old one immediately. Point the extension at this
            backend&apos;s URL (default http://127.0.0.1:8000).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Globe size={14} /> Sites</CardTitle>
          <CardDescription>
            The extension runs ONLY on these domains — never on arbitrary pages. Add each site
            you watch on once, as anime or YouTube; the matching module activates there.
            You can also add the current site from the extension popup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="example.com"
              value={newDomain}
              onChange={(event) => setNewDomain(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newDomain.trim()) addSite();
              }}
            />
            <Select value={newMedia} onValueChange={(value) => setNewMedia(value as "ani" | "yt")}>
              <SelectTrigger className="w-32" aria-label="Site type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ani">Anime</SelectItem>
                <SelectItem value="yt">YouTube</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" disabled={!newDomain.trim()} onClick={addSite}>
              Add
            </Button>
          </div>
          {domains.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No sites yet — the extension does nothing until you add one.
            </p>
          ) : (
            <div className="space-y-4">
              {([["ani", "Anime sites"], ["yt", "YouTube sites"]] as const).map(([media, title]) => {
                const items = domains.filter((d) => d.media === media);
                if (items.length === 0) return null;
                return (
                  <div key={media} className="space-y-2">
                    <span className="text-xs font-medium text-muted-foreground">{title}</span>
                    <ul className="space-y-2">
                      {items.map((d) => (
                        <li key={d.id} className="flex items-center gap-2 text-sm">
                          <Switch
                            checked={d.enabled}
                            aria-label={`Enable ${d.domain ?? "site"}`}
                            onCheckedChange={(checked) =>
                              void act(async () => {
                                await api.extSetDomainEnabled(d.id, checked);
                                await loadDomains();
                              }, checked ? "Site enabled" : "Site disabled")
                            }
                          />
                          <span className="flex-1 truncate font-mono text-xs">{d.domain ?? "…"}</span>
                          <Badge variant="secondary">{d.media === "ani" ? "Anime" : "YouTube"}</Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove ${d.domain ?? "site"}`}
                            onClick={() =>
                              void act(async () => {
                                await api.extRemoveDomain(d.id);
                                await loadDomains();
                              }, "Site removed")
                            }
                          >
                            <Trash2 size={13} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><History size={14} /> Learned watch sites</CardTitle>
          <CardDescription>
            Built passively: when the extension recognizes an anime on a page, it remembers the
            site, so an episode-released notification can open the right place directly.
            Delete rows you do not want used — they relearn on your next visit.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {learned.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing learned yet — bind or let the extension recognize an anime page first.
            </p>
          ) : (
            <ul className="space-y-2">
              {learned.map((site) => (
                <li key={site.id} className="flex items-center gap-2 text-sm">
                  <span className="w-40 truncate font-medium">{site.entryTitle ?? "?"}</span>
                  <Badge variant="secondary">{site.domain ?? "?"}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={site.url ?? ""}>
                    {site.url ?? ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {site.season ? `S${site.season}` : ""}{site.episode ? ` E${site.episode}` : ""} · ×{site.useCount}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Forget ${site.domain ?? "site"} for ${site.entryTitle ?? "entry"}`}
                    onClick={() =>
                      void act(async () => {
                        await api.extDeleteLearnedSite(site.id);
                        await loadLearned();
                      }, "Learned site forgotten")
                    }
                  >
                    <Trash2 size={13} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
