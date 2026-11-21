import { useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import { Button } from "@/components/ui/button";
import { FileButton } from "@/components/ui/file-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Per-user settings: three backup styles — linkwarden txt (D56), CSV
 * (FreeTube/HydraWatch migration), pg_dump lives in Admin (D33). */
export default function Settings() {
  const { notify, act } = useApp();
  const [csvMedia, setCsvMedia] = useState<"yt" | "ani">("yt");

  const downloadCsv = async (media: "yt" | "ani") => {
    const result = await api.exportCsv(media);
    const blob = new Blob([result.exportCsv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dreamedia-${media === "yt" ? "youtube" : "anime"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify("CSV exported", "ok");
  };

  const importCsvFile = async (file: File) => {
    const text = await file.text();
    await act(async () => {
      const result = await api.importCsv(csvMedia, text);
      const r = result.importCsv;
      notify(
        `Imported ${r.imported}, skipped ${r.skipped}${r.errors.length ? ` — first issue: ${r.errors[0]}` : ""}`,
        r.imported > 0 ? "ok" : "error",
      );
    });
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
        <p className="text-xs text-muted-foreground">Per-user: portable txt and CSV backups.</p>
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
            <FileButton size="sm" variant="secondary" accept=".txt,.json" onFile={(file) => void importFile(file)}>
              <Upload size={13} /> Import backup
            </FileButton>
          </div>
          <p className="text-xs text-muted-foreground">
            Import re-tracks channels and anime from their links — the backend re-resolves
            metadata. Your cursor positions and watched seasons are restored with them.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><FileSpreadsheet size={14} /> CSV backup</CardTitle>
          <CardDescription>
            One CSV per media — the YouTube file is FreeTube-compatible in its first three
            columns, so FreeTube and HydraWatch exports import directly for migration.
            Our own exports round-trip modes, labels, categories, and cursors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void downloadCsv("yt")}>
              <Download size={13} /> YouTube CSV
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void downloadCsv("ani")}>
              <Download size={13} /> Anime CSV
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select value={csvMedia} onValueChange={(value) => setCsvMedia(value as "yt" | "ani")}>
              <SelectTrigger className="w-36" aria-label="Import media">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yt">YouTube CSV</SelectItem>
                <SelectItem value="ani">Anime CSV</SelectItem>
              </SelectContent>
            </Select>
            <FileButton size="sm" accept=".csv,text/csv" onFile={(file) => void importCsvFile(file)}>
              <Upload size={13} /> Import CSV
            </FileButton>
          </div>
          <p className="text-xs text-muted-foreground">
            YouTube rows resolve channels the same way subscribe-from-page does; anime rows
            re-track titles through AniList. Foreign rows without a URL or title are skipped
            and reported.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
