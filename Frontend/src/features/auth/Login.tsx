import { useState, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import { useApp } from "../../app/state";
import { BackendError } from "../../lib/gql";

export default function Login() {
  const { login, signup } = useApp();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "login") await login(username.trim(), password);
      else await signup(username.trim(), password);
    } catch (cause) {
      setError(
        cause instanceof BackendError || cause instanceof Error
          ? cause.message
          : "Could not reach the backend.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="auth__brand">
        <div className="auth__logo">
          <span className="mark">d/</span>
          drea<span style={{ color: "var(--faint)" }}>/</span>media
        </div>

        <div className="auth__headline">
          <h1>
            Everything you follow.
            <br />
            <em>Nothing you don&apos;t.</em>
          </h1>
          <p>
            A single workspace for YouTube sources and anime releases — with notification control
            down to the channel, and a bell that only carries messages from the backend.
          </p>
          <div className="auth__points">
            <div className="auth__point">
              <Check size={13} />
              <span>
                Track, WordScan, Random and Playlist notifications, scoped by domain and subdomain.
              </span>
            </div>
            <div className="auth__point">
              <Check size={13} />
              <span>
                Anime release and change alerts with season, episode and airing-time context.
              </span>
            </div>
            <div className="auth__point">
              <Check size={13} />
              <span>Manual playlists from any video link, plus a real watch queue.</span>
            </div>
          </div>
        </div>

        <div className="auth__meta">
          <span>Postgres · encrypted at rest</span>
          <span>GraphQL API</span>
          <span>Self-hosted</span>
        </div>
      </section>

      <section className="auth__form">
        <form className="auth-card" onSubmit={submit}>
          <div>
            <h2>{mode === "login" ? "Welcome back" : "Create your workspace"}</h2>
            <p style={{ marginTop: 6, color: "var(--faint)", fontSize: 12.5 }}>
              {mode === "login"
                ? "Your session unlocks the encrypted vault."
                : "The first account becomes the admin."}
            </p>
          </div>

          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              data-active={mode === "login"}
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              data-active={mode === "signup"}
              onClick={() => {
                setMode("signup");
                setError("");
              }}
            >
              Sign up
            </button>
          </div>

          <label className="field">
            <span>Username</span>
            <input
              className="input"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="your-handle"
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
            />
          </label>

          {error && <div className="form-error">{error}</div>}

          <button
            className="btn btn--primary"
            style={{ height: 38, justifyContent: "center" }}
            disabled={busy}
          >
            {busy ? <Loader2 size={14} className="spin" /> : null}
            {mode === "login" ? "Sign in" : "Create workspace"}
          </button>

          <p className="auth-hint">
            Sessions are in-memory and keys derive from your password at login — nothing readable is
            stored on the server.
          </p>
        </form>
      </section>
    </div>
  );
}
