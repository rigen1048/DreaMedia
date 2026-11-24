// ---- conditional fields ----
function showSubscriptionFields() {
  const kind = $("kind").value;
  $("wordsField").hidden = kind !== "wordscan";
  $("rankField").hidden = kind !== "random";
  $("withholdField").hidden = kind !== "withhold";
}
$("kind").addEventListener("change", showSubscriptionFields);
showSubscriptionFields();

let categories = [];
let lastCategoryDomainValue = "";
function fillDatalist(id, values) {
  const list = $(id);
  list.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    list.append(option);
  }
}
function updateCategorySuggestions() {
  const domainName = $("domain").value.trim();
  if (domainName.toLowerCase() !== lastCategoryDomainValue.toLowerCase()) {
    $("subdomain").value = "";
    lastCategoryDomainValue = domainName;
  }
  const domain = categories.find((row) => row.name.toLowerCase() === domainName.toLowerCase());
  const subdomainInput = $("subdomain");
  subdomainInput.disabled = !domainName;
  subdomainInput.placeholder = domainName ? "Existing or new subdomain" : "Choose a domain first";
  fillDatalist("subdomainSuggestions", (domain?.subdomains || []).map((row) => row.name));
}
$("domain").addEventListener("input", updateCategorySuggestions);

let scannedSubscriptions = [];
let subscriptionScanComplete = false;
const activeImportJobs = new Map();
const failedImportJobs = new Set();
const recentImportJobIds = new Set();
const pollingImportJobs = new Set();
let importJobsStorageWrite = Promise.resolve();
let scanStatusMessage = "";
let scanStatusClass = "";
let lastImportStatus = "";
let lastImportStatusClass = "";
