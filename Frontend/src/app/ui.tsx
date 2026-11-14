import { Check, Inbox, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function MiniSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className="mini-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

export function CheckBox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="check"
      data-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <Check size={11} strokeWidth={3} />
    </button>
  );
}

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
    <div className="empty">
      {icon ?? <Inbox size={20} />}
      <div>
        <div style={{ color: "var(--dim)", fontSize: 12.5, fontWeight: 600 }}>{title}</div>
        {hint && <div style={{ marginTop: 3, fontSize: 11.5 }}>{hint}</div>}
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
  const base = className ?? "feed-thumb";
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div className={`${base} thumb-fallback`} aria-hidden="true" title={alt}>
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
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span
            className="dot"
            style={{
              marginTop: 5,
              color:
                toast.tone === "error"
                  ? "var(--danger)"
                  : toast.tone === "ok"
                    ? "var(--ok)"
                    : "var(--accent)",
            }}
          />
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmButton({
  onConfirm,
  children,
  label,
  className = "icon-btn icon-btn--danger",
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
    <button
      type="button"
      className={className}
      aria-label={label}
      title={armed ? "Click again to confirm" : label}
      style={armed ? { color: "var(--danger)", background: "var(--danger-soft)" } : undefined}
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
    </button>
  );
}
