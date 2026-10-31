import { useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useMedia } from "../media";
import type { SubscribeInput } from "../media/api";
import { AddSourceForm } from "./AddSourceForm";
import { ManagementPanels } from "./ManagementPanels";
import { errorMessage, type CategoryAssignment, type ManagementTab } from "./model";

export default function ManagementPage() {
  const { channels, domains, subscribeYoutube, createCategory, refresh } = useMedia();
  const [tab, setTab] = useState<ManagementTab>("channels");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [standaloneDomain, setStandaloneDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const shownChannels = useMemo(
    () =>
      channels
        .filter((channel) =>
          tab === "inactive"
            ? channel.label !== "none" || channel.active === false
            : channel.label === "none",
        )
        .filter((channel) =>
          `${channel.name} ${channel.url} ${channel.domain} ${channel.subdomain} ${channel.mode}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
    [channels, search, tab],
  );

  const addSource = async (input: SubscribeInput, category?: CategoryAssignment): Promise<void> => {
    await subscribeYoutube(input, category);
  };

  const addDomain = async () => {
    setBusy(true);
    setError("");
    try {
      await createCategory(standaloneDomain.trim(), null);
      setStandaloneDomain("");
    } catch (cause) {
      setError(errorMessage(cause, "Backend update failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-content management-page minimal-page">
      <div className="page-heading-row minimal-heading">
        <div>
          <span className="page-kicker">MODE 02</span>
          <h1>Management</h1>
        </div>
        <div className="heading-right">
          <button className="outline-button" onClick={() => void refresh()}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="primary-button" onClick={() => setAddOpen((value) => !value)}>
            <Plus size={15} /> Add source
          </button>
        </div>
      </div>
      <div className="management-tabs compact-tabs">
        <button className={tab === "channels" ? "active" : ""} onClick={() => setTab("channels")}>
          Channels <span>{channels.filter((channel) => channel.label === "none").length}</span>
        </button>
        <button
          className={tab === "categories" ? "active" : ""}
          onClick={() => setTab("categories")}
        >
          Domains <span>{domains.length}</span>
        </button>
        <button className={tab === "inactive" ? "active" : ""} onClick={() => setTab("inactive")}>
          Inactive / labels
          <span>
            {
              channels.filter((channel) => channel.label !== "none" || channel.active === false)
                .length
            }
          </span>
        </button>
      </div>
      {error && (
        <div className="inline-api-error" role="alert">
          {error}
        </div>
      )}
      {addOpen && (
        <AddSourceForm
          domains={domains}
          onAdd={addSource}
          onCancel={() => setAddOpen(false)}
          onError={setError}
        />
      )}
      <ManagementPanels
        tab={tab}
        channels={shownChannels}
        domains={domains}
        search={search}
        onSearchChange={setSearch}
        standaloneDomain={standaloneDomain}
        onStandaloneDomainChange={setStandaloneDomain}
        onAddDomain={() => void addDomain()}
        busy={busy}
        onError={setError}
      />
    </div>
  );
}
