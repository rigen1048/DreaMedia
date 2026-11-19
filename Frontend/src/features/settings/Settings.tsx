import { useState } from "react";
import { Copy, Download, KeyRound, Upload } from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Per-user settings: extension token (D55) + portable txt backup (D56). */
export default function Settings() {
  const { notify, act } = useApp();
  const [token, setToken] = useState<string | null>(null);

  const issueToken = async () => {
    const result = await api.extIssueToken();
    setToken(result.extIssueToken);
    notify("Extension token issued — copy it now, it will not be shown again", "ok");
  };

  const downloadExport = async () => {
    const result = await api.exportData();
    const blob = new Blob([result.exportData], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dreamedia-backup-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Portable backup downloaded", "ok");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    await act(async () => {
      const result = await api.importData(text);
      const c = result.importData;
      notify(
        `Imported: ${c.channels} channels, ${c.cards} playlists, ${c.anime} anime (${c.skipped} skipped)`,
        "ok",
      );
    });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground">Per-user: extension access and the portable backup.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><KeyRound size={14} /> Browser extension</CardTitle>
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
          <CardTitle className="flex items-center gap-2 text-sm"><Download size={14} /> Portable backup (.txt)</CardTitle>
          <CardDescription>
            A linkwarden-style export: your data, decrypted, as plain text. Unlike a pg_dump this
            survives schema changes — importing re-encrypts under the current schema.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void downloadExport()}>
              <Download size={13} /> Download backup
            </Button>
            <label>
              <input
                type="file"
                accept=".txt,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importFile(file);
                }}
              />
              <Button size="sm" variant="secondary" asChild>
                <span><Upload size={13} /> Import backup</span>
              </Button>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Import re-tracks channels and anime from their links — the backend re-resolves
            metadata. Your cursor positions and watched seasons are restored with them.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
