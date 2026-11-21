import { Download, Upload } from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Per-user settings: the portable txt backup (D56). Extension management
 * (token, sites) lives on the dedicated Extension page. */
export default function Settings() {
  const { notify, act } = useApp();

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
        <p className="text-xs text-muted-foreground">Per-user: the portable backup.</p>
      </div>

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
