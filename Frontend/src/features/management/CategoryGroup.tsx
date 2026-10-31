import { useState } from "react";
import { useMedia, type ManagedDomain } from "../media";
import { errorMessage } from "./model";

type CategoryGroupProps = {
  domain: ManagedDomain;
  onError: (message: string) => void;
};

export function CategoryGroup({ domain, onError }: CategoryGroupProps) {
  const { createCategory, renameCategory, deleteCategory, setCategoryActive } = useMedia();
  const [newSubdomain, setNewSubdomain] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    onError("");
    try {
      await operation();
      setNewSubdomain("");
    } catch (error) {
      onError(errorMessage(error, "Category update failed."));
    } finally {
      setBusy(false);
    }
  };

  const promptRenameDomain = () => {
    const next = window.prompt("Rename domain", domain.name)?.trim();
    if (next && next !== domain.name) {
      void run(() => renameCategory(domain.name, next, null));
    }
  };

  const promptRenameSubdomain = (subdomain: string) => {
    const next = window.prompt("Rename subdomain", subdomain)?.trim();
    if (next && next !== subdomain) {
      void run(() => renameCategory(domain.name, next, subdomain));
    }
  };

  return (
    <section className="category-admin-group">
      <div className="category-admin-domain">
        <strong>{domain.name}</strong>
        <button
          className={`active-toggle ${domain.active ? "on" : ""}`}
          disabled={busy}
          onClick={() => void run(() => setCategoryActive(domain.name, null, !domain.active))}
        >
          {domain.active ? "Active" : "Inactive"}
        </button>
        <button className="quiet-action" disabled={busy} onClick={promptRenameDomain}>
          Rename
        </button>
        <button
          className="quiet-action danger-action"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete domain ${domain.name}? Channels become uncategorized.`)) {
              void run(() => deleteCategory(domain.name, null));
            }
          }}
        >
          Delete
        </button>
      </div>
      {domain.subdomains.map((subdomain) => (
        <div className="category-admin-sub" key={subdomain.id}>
          <span>{subdomain.name}</span>
          <button
            className={`active-toggle ${subdomain.active ? "on" : ""}`}
            disabled={busy}
            onClick={() =>
              void run(() => setCategoryActive(domain.name, subdomain.name, !subdomain.active))
            }
          >
            {subdomain.active ? "Active" : "Inactive"}
          </button>
          <button
            className="quiet-action"
            disabled={busy}
            onClick={() => promptRenameSubdomain(subdomain.name)}
          >
            Rename
          </button>
          <button
            className="quiet-action danger-action"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete ${domain.name}/${subdomain.name}?`)) {
                void run(() => deleteCategory(domain.name, subdomain.name));
              }
            }}
          >
            Delete
          </button>
        </div>
      ))}
      <div className="category-add-row">
        <input
          value={newSubdomain}
          onChange={(event) => setNewSubdomain(event.target.value)}
          placeholder="New subdomain"
        />
        <button
          className="quiet-action"
          disabled={busy || !newSubdomain.trim()}
          onClick={() => void run(() => createCategory(domain.name, newSubdomain.trim()))}
        >
          Add
        </button>
      </div>
    </section>
  );
}
