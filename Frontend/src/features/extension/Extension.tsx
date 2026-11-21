import { useEffect, useState } from "react";
import { Copy, Globe, KeyRound, Trash2 } from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import type { ExtDomain } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Extension management: personal token (D55) + the sites allowlist that
 * scopes where the extension runs at all (ext v2 phase 1). */
export default function Extension() {
  const { notify, act } = useApp();
  const [token, setToken] = useState<string | null>(null);
  const [domains, setDomains] = useState<ExtDomain[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [newMedia, setNewMedia] = useState<"ani" | "yt">("ani");

  const loadDomains = async () => {
    try {
      setDomains((await api.extDomains()).extDomains);
    } catch {
      // vault locked or offline — leave the list empty; actions will surface errors
    }
  };
  useEffect(() => {
    void loadDomains();
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
            <ul className="space-y-2">
              {domains.map((d) => (
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
