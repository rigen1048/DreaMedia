import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell as BellIcon, Check, Radio, X } from "lucide-react";
import { useApp } from "../../app/state";
import { listMessages, markMessagesSeen, NotificationApiError } from "../../lib/notifications";
import { timeAgo } from "../../lib/format";
import type { BellMessage } from "../../lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * The bell reads durable notification history and read state from PostgreSQL
 * through the authenticated backend API. It never reads the YouTube/Anime feed.
 */
export default function Bell() {
  const { viewer } = useApp();
  const [messages, setMessages] = useState<BellMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(false);
  const [vaultLocked, setVaultLocked] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const userId = viewer?.id;

  const pull = useCallback(async () => {
    if (!userId) return;
    try {
      setMessages(await listMessages());
      setOnline(true);
      setVaultLocked(false);
    } catch (error) {
      setOnline(false);
      const locked = error instanceof NotificationApiError && error.status === 423;
      setVaultLocked(locked);
      if (locked) setMessages([]);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void pull();
    const poll = window.setInterval(() => void pull(), 15_000);
    return () => {
      window.clearInterval(poll);
    };
  }, [pull, userId]);

  useEffect(() => {
    if (open && list.current) list.current.scrollTop = 0;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = useMemo(() => messages.filter((message) => !message.seen), [messages]);

  const setSeen = async (message: BellMessage, seen: boolean) => {
    setMessages((current) =>
      current.map((item) => (item.id === message.id ? { ...item, seen } : item)),
    );
    try {
      await markMessagesSeen([message.id], seen);
    } catch {
      void pull();
    }
  };

  const acknowledge = async (message: BellMessage) => setSeen(message, !message.seen);

  const acknowledgeAll = async () => {
    const ids = unread.map((message) => message.id);
    if (!ids.length) return;
    setMessages((current) => current.map((item) => ({ ...item, seen: true })));
    try {
      await markMessagesSeen(ids, true);
    } catch {
      void pull();
    }
  };

  return (
    <div className="relative" ref={panel}>
      <Button
        variant="ghost"
        aria-label={`Backend messages${unread.length ? `, ${unread.length} unread` : ""}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          void pull();
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
      >
        <BellIcon size={17} strokeWidth={1.9} />
        {unread.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Backend messages"
          className="absolute right-0 top-11 z-50 flex w-96 flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
        >
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <strong className="text-sm">Backend messages</strong>
            <span className="text-xs text-muted-foreground">{unread.length} new</span>
            <span className="grow" />
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-sky-500"
              disabled={!unread.length}
              onClick={() => void acknowledgeAll()}
            >
              Mark all read
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </Button>
          </div>

          <div ref={list} className="max-h-96 overflow-y-auto">
            {messages.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <Radio size={18} className="text-muted-foreground" />
                <div className="text-sm">
                  {vaultLocked ? "Notifications are locked." : "No backend messages yet."}
                </div>
                <div className="text-xs text-muted-foreground">
                  {vaultLocked
                    ? "Sign in again to unlock your encrypted notifications."
                    : online
                      ? "No PostgreSQL notifications yet."
                      : "PostgreSQL notifications are unavailable."}
                </div>
              </div>
            )}
            {messages.slice(0, 40).map((message) => (
              <Button
                key={message.id}
                variant="ghost"
                onClick={() => void acknowledge(message)}
                title={message.seen ? "Mark unread" : "Mark read"}
                className={cn(
                  "flex h-auto w-full items-start justify-start gap-2.5 rounded-none border-b px-4 py-2.5 text-left whitespace-normal",
                  !message.seen && "bg-accent/30",
                )}
              >
                <span className="mt-1 shrink-0 text-muted-foreground">
                  {message.seen ? (
                    <Check size={13} />
                  ) : (
                    <span className="block h-1.5 w-1.5 rounded-full bg-sky-500" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {message.title || message.kind}
                  </span>
                  {message.message && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {message.message}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {timeAgo(message.createdAt)} · {message.media === "yt" ? "YouTube" : "Anime"}
                  </span>
                </span>
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 border-t px-4 py-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                online ? "bg-emerald-500" : "bg-destructive",
              )}
            />
            {online
              ? "PostgreSQL connected"
              : vaultLocked
                ? "Vault locked"
                : "PostgreSQL unavailable"}
            <span className="grow" />
            <span>database-backed history</span>
          </div>
        </div>
      )}
    </div>
  );
}
