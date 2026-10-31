import type { CategoryFiltersProps } from "./filterTypes";

export default function CategoryFilters({
  selectedDomain,
  selectedSubdomain,
  domains,
  categoryBuckets,
  subdomainsForDomain,
  onDomainChange,
  onSubdomainChange,
}: CategoryFiltersProps) {
  if (domains.length > 1) {
    return (
      <div className="category-filter-area">
        <div className="domain-filter-list">
          <button
            className={`domain-filter ${!selectedDomain ? "active" : ""}`}
            onClick={() => onDomainChange(null)}
          >
            <span>All</span>
            <b>{categoryBuckets.reduce((sum, item) => sum + item.count, 0)}</b>
          </button>
          {domains.map((domain) => {
            const subdomains = subdomainsForDomain(domain);
            const domainCount = subdomains.reduce((sum, item) => sum + item.count, 0);
            const isDomainSelected = selectedDomain === domain && !selectedSubdomain;

            return (
              <div className="domain-filter-group" key={domain}>
                <button
                  className={`domain-filter ${isDomainSelected ? "active" : ""}`}
                  onClick={() => onDomainChange(isDomainSelected ? null : domain)}
                >
                  <span>{domain}</span>
                  <b>{domainCount}</b>
                </button>
                {subdomains.map((item) => (
                  <button
                    key={item.subdomain}
                    className={`subdomain-filter ${selectedDomain === domain && selectedSubdomain === item.subdomain ? "active" : ""}`}
                    onClick={() => {
                      onDomainChange(domain);
                      onSubdomainChange(
                        selectedSubdomain === item.subdomain ? null : item.subdomain,
                      );
                    }}
                  >
                    <span>{item.subdomain}</span>
                    <b>{item.count}</b>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="category-filter-area">
      <div className="subdomain-filter-list">
        <button
          className={`subdomain-filter ${!selectedSubdomain ? "active" : ""}`}
          onClick={() => onSubdomainChange(null)}
        >
          All
        </button>
        {categoryBuckets.map((item) => (
          <button
            key={item.subdomain}
            className={`subdomain-filter ${selectedSubdomain === item.subdomain ? "active" : ""}`}
            onClick={() =>
              onSubdomainChange(selectedSubdomain === item.subdomain ? null : item.subdomain)
            }
          >
            <span>{item.subdomain}</span>
            <b>{item.count}</b>
          </button>
        ))}
      </div>
    </div>
  );
}
