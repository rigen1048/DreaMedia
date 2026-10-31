import { useState, type FormEvent } from "react";
import { LockKeyhole, LogIn } from "lucide-react";
import { useMedia } from "../data/MediaContext";

export default function Login() {
  const { login, signup, authError, refresh } = useMedia();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [createAccount, setCreateAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await (createAccount ? signup(username, password) : login(username, password)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sign in failed."); }
    finally { setBusy(false); }
  };
  return <main className="auth-screen"><section className="auth-card">
    <div className="auth-brand"><span className="brand-mark"><span /></span><span className="brand-word">drea<span>/</span>media</span></div>
    <h1>{createAccount ? "Create account" : "Sign in"}</h1>
    <p>Connect to your DreaMedia backend.</p>
    <form onSubmit={submit} className="auth-form"><label>Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>Password<input type="password" autoComplete={createAccount ? "new-password" : "current-password"} minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary-button" disabled={busy}>{createAccount ? <LockKeyhole size={15} /> : <LogIn size={15} />}{busy ? "Connecting…" : createAccount ? "Create account" : "Sign in"}</button></form>
    {(error || authError) && <p className="auth-error" role="alert">{error ?? authError}</p>}
    <button className="auth-toggle" onClick={() => { setCreateAccount((value) => !value); setError(null); }}>{createAccount ? "Already have an account? Sign in" : "Need an account? Sign up"}</button>
    <button className="auth-retry" onClick={() => void refresh()}>Retry backend connection</button>
  </section></main>;
}
