import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell as BellIcon, Check, Radio, X } from "lucide-react";
import { useApp } from "../../app/state";
import { listMessages, markMessagesSeen, openMessageStream } from "../../lib/bridge";
import { timeAgo } from "../../lib/format";
import type { BellMessage } from "../../lib/types";

/**
 * The bell only ever shows backend-originated messages delivered through the
 * frontend's REST receiver. It never reads the YouTube/Anime feed.
 */
export default function Bell() {
  const { viewer } = useApp();
  const [messages, setMessages] = useState<BellMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const userId = viewer?.id;

  const pull = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await listMessages(userId);
      setMessages(data.messages);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void pull();
    const stop = openMessageStream(
      userId,
      (message) => {
        setMessages((current) => {
          if (current.some((item) => item.id === message.id)) return current;
          return [{ ...message, seen: false }, ...current].slice(0, 200);
        });
      },
      setOnline,
    );
    const poll = window.setInterval(() => void pull(), 30_000);
    return () => {
      stop();
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

  const acknowledge = async (message: BellMessage) => {
    if (message.seen) return;
    setMessages((current) =>
      current.map((item) => (item.id === message.id ? { ...item, seen: true } : item)),
    );
    if (userId) {
      try {
        await markMessagesSeen(userId, [message.id]);
      } catch {
        /* keep local state */
      }
    }
  };

  const acknowledgeAll = async () => {
    const ids = unread.map((message) => message.id);
    if (!ids.length) return;
    setMessages((current) => current.map((item) => ({ ...item, seen: true })));
    if (userId) {
      try {
        await markMessagesSeen(userId, ids);
      } catch {
        /* keep local state */
      }
    }
  };

  return (
    <div className="bell-wrap" ref={panel}>
      <button
        className="bell"
        aria-label={`Backend messages${unread.length ? `, ${unread.length} unread` : ""}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          void pull();
        }}
      >
        <BellIcon size={17} strokeWidth={1.9} />
        {unread.length > 0 && (
          <span className="bell__count">{unread.length > 9 ? "9+" : unread.length}</span>
        )}
      </button>

      {open && (
        <div className="bell-panel" role="dialog" aria-label="Backend messages">
          <div className="bell-panel__head">
            <strong>Backend messages</strong>
            <span>{unread.length} new</span>
            <span className="grow" />
            <button
              className="link-btn"
              disabled={!unread.length}
              onClick={() => void acknowledgeAll()}
            >
              Mark all read
            </button>
            <button className="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>

          <div className="bell-list" ref={list}>
            {messages.length === 0 && (
              <div className="empty" style={{ padding: "28px 16px" }}>
                <Radio size={18} />
                <div>
                  <div style={{ color: "var(--dim)" }}>No backend messages yet.</div>
                  <div style={{ fontSize: 11, marginTop: 3 }}>
                    {online
                      ? "The receiver is online and waiting."
                      : "Notification receiver offline — is the bridge running?"}
                  </div>
                </div>
              </div>
            )}
            {messages.slice(0, 40).map((message) => (
              <button
                key={message.id}
                className="bell-item"
                data-media={message.media}
                onClick={() => void acknowledge(message)}
                title={message.seen ? "Mark unread" : "Mark read"}
              >
                <span className="bell-item__icon">
                  {message.seen ? <Check size={13} /> : <span className="dot" />}
                </span>
                <span className="bell-item__body">
                  <span className="bell-item__title">{message.title || message.kind}</span>
                  {message.message && <span className="bell-item__msg">{message.message}</span>}
                  <span className="bell-item__time">
                    {timeAgo(message.createdAt)} · {message.media === "yt" ? "YouTube" : "Anime"}
                  </span>
                </span>
                {!message.seen && <span className="bell-item__dot" />}
              </button>
            ))}
          </div>

          <div className="bell-panel__foot">
            <span className={`dot`} style={{ color: online ? "var(--ok)" : "var(--danger)" }} />
            {online ? "REST receiver online" : "Receiver offline"}
            <span className="grow" />
            <span>backend push · /bridge</span>
          </div>
        </div>
      )}
    </div>
  );
}
