import { useState, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import { useApp } from "../../app/state";
import { BackendError } from "../../lib/gql";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const POINTS = [
  "Track, WordScan, Random and Playlist notifications, scoped by domain and subdomain.",
  "Anime release and change alerts with season, episode and airing-time context.",
  "Manual playlists from any video link, plus a real watch queue.",
];

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
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand side */}
      <section className="hidden flex-col justify-between border-r bg-card p-10 lg:flex">
        <div className="text-xl font-bold">
          drea<span className="text-muted-foreground">/</span>media
        </div>
        <div className="max-w-md space-y-6">
          <h1 className="text-4xl font-bold leading-tight">
            Everything you follow.
            <br />
            <em className="text-muted-foreground">Nothing you don&apos;t.</em>
          </h1>
          <p className="text-sm text-muted-foreground">
            A single workspace for YouTube sources and anime releases — with notification
            control down to the channel, and a bell that only carries messages from the backend.
          </p>
          <div className="space-y-3">
            {POINTS.map((point) => (
              <div key={point} className="flex items-start gap-2 text-sm">
                <Check size={14} className="mt-0.5 shrink-0 text-emerald-500" />
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>Postgres · encrypted at rest</span>
          <span>GraphQL API</span>
          <span>Self-hosted</span>
        </div>
      </section>

      {/* Form side */}
      <section className="flex items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>{mode === "login" ? "Welcome back" : "Create your workspace"}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {mode === "login"
                ? "Your session unlocks the encrypted vault."
                : "The first account becomes the admin."}
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                {(["login", "signup"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m);
                      setError("");
                    }}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer",
                      mode === m ? "bg-background shadow" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m === "login" ? "Sign in" : "Sign up"}
                  </button>
                ))}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="your-handle"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                />
              </div>

              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}

              <Button className="w-full" disabled={busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                {mode === "login" ? "Sign in" : "Create workspace"}
              </Button>

              <p className="text-xs text-muted-foreground">
                Sessions are in-memory and keys derive from your password at login — nothing
                readable is stored on the server.
              </p>
            </form>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
