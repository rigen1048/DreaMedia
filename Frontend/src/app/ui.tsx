import { Inbox, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export { Switch } from "@/components/ui/switch";

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center text-muted-foreground">
      {icon ?? <Inbox size={22} />}
      <div>
        <div className="text-sm font-semibold text-foreground/80">{title}</div>
        {hint && <div className="mt-1 text-xs">{hint}</div>}
      </div>
      {action}
    </div>
  );
}

export function Thumb({
  src,
  alt,
  className,
  fallback,
}: {
  src?: string | null;
  alt: string;
  className?: string;
  fallback?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const base = cn("aspect-video w-40 shrink-0 rounded-lg object-cover bg-muted", className);
  if (!src || failed) {
    return (
      <div
        className={cn(base, "flex items-center justify-center text-lg font-bold text-muted-foreground")}
        aria-hidden="true"
        title={alt}
      >
        {fallback ?? alt.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      className={base}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Array<{ id: number; message: string; tone: "error" | "ok" | "info" }>;
  onDismiss: (id: number) => void;
}) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm shadow-lg"
        >
          <span
            className={cn(
              "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
              toast.tone === "error"
                ? "bg-destructive"
                : toast.tone === "ok"
                  ? "bg-emerald-500"
                  : "bg-sky-500",
            )}
          />
          <span className="flex-1">{toast.message}</span>
          <Button variant="ghost" size="icon" className="h-5 w-5" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <X size={13} />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmButton({
  onConfirm,
  children,
  label,
  className,
}: {
  onConfirm: () => void;
  children: ReactNode;
  label: string;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 2600);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      type="button"
      variant={armed ? "destructive" : "ghost"}
      size="icon"
      className={className}
      aria-label={label}
      title={armed ? "Click again to confirm" : label}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {children}
    </Button>
  );
}
