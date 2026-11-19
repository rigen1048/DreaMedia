"""DreaMedia Extension API (D55) — the localhost endpoint the browser
extension talks to. Auth is a per-user extension token (X-DreaMedia-Token),
NOT the session cookie: the extension is a separate client (the GraphQL-only
rule governs the frontend app, not this machine-local API)."""
