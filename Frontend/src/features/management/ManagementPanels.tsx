import { Search } from "lucide-react";
import type { ManagedChannel, ManagedDomain } from "../media";
import { CategoryGroup } from "./CategoryGroup";
import { ChannelRow } from "./ChannelRow";
import type { ManagementTab } from "./model";

type ManagementPanelsProps = {
  tab: ManagementTab;
  channels: ManagedChannel[];
  domains: ManagedDomain[];
  search: string;
  onSearchChange: (value: string) => void;
  standaloneDomain: string;
  onStandaloneDomainChange: (value: string) => void;
  onAddDomain: () => void;
  busy: boolean;
  onError: (message: string) => void;
};

type ChannelListProps = {
  channels: ManagedChannel[];
  emptyMessage: string;
  onError: (message: string) => void;
};

function ChannelList({ channels, emptyMessage, onError }: ChannelListProps) {
  return (
    <div className="management-list">
      {channels.map((channel) => (
        <ChannelRow key={channel.id} channel={channel} onError={onError} />
      ))}
      {channels.length === 0 && <div className="minimal-empty">{emptyMessage}</div>}
    </div>
  );
}

export function ManagementPanels({
  tab,
  channels,
  domains,
  search,
  onSearchChange,
  standaloneDomain,
  onStandaloneDomainChange,
  onAddDomain,
  busy,
  onError,
}: ManagementPanelsProps) {
  if (tab === "categories") {
    return (
      <section className="management-panel compact-panel">
        <div className="panel-heading">
          <h2>
            Domains / subdomains
            <span className="panel-count">{domains.length}</span>
          </h2>
        </div>
        <div className="category-add-row standalone-category">
          <input
            value={standaloneDomain}
            onChange={(event) => onStandaloneDomainChange(event.target.value)}
            placeholder="New domain"
          />
          <button
            className="primary-button small-primary"
            disabled={busy || !standaloneDomain.trim()}
            onClick={onAddDomain}
          >
            Add domain
          </button>
        </div>
        <div className="category-admin-list">
          {domains.map((domain) => (
            <CategoryGroup key={domain.id} domain={domain} onError={onError} />
          ))}
          {domains.length === 0 && (
            <div className="minimal-empty">No configured categories returned by the backend.</div>
          )}
        </div>
      </section>
    );
  }

  const emptyMessage =
    tab === "channels"
      ? "No channels returned by the backend."
      : "No inactive or labelled source records.";
  const heading =
    tab === "channels" ? (
      <>
        Channels <span className="panel-count">{channels.length}</span>
      </>
    ) : (
      "Reserved / blocked / inactive"
    );

  return (
    <section className="management-panel compact-panel">
      <div className="panel-heading">
        <h2>{heading}</h2>
        {tab === "channels" && (
          <label className="table-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Find a channel /"
            />
          </label>
        )}
      </div>
      <ChannelList channels={channels} emptyMessage={emptyMessage} onError={onError} />
    </section>
  );
}
