import { useQuery } from "@tanstack/react-query";
import { getPresence, shareErrText } from "../../api/share";
import { Spinner } from "../ui/spinner";
import { relAgo } from "./ShareCard";

/** Offline label. A member whose clock runs ahead reports a future `last_seen`,
 * which relAgo floors to "just now" next to an offline dot. */
function seenText(iso: string): string {
  return new Date(iso).getTime() > Date.now() ? "clock out of sync" : `seen ${relAgo(iso)}`;
}

/** Who's online on an e2ee share, from each member's last sync heartbeat.
 * Every role can read it; viewer-role heartbeats never land at the host, so
 * viewers show as never seen. Refreshes each minute; changes propagate on the
 * members' own sync passes, so "online" lags by up to one interval. */
export function PresenceSection({ shareId }: { shareId: string }) {
  const q = useQuery({
    queryKey: ["share", "presence", shareId],
    queryFn: () => getPresence(shareId),
    refetchInterval: 60_000,
  });
  const rows = (q.data?.members ?? []).filter((m) => m.member_id !== q.data?.self_member_id);
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
      <span
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: "var(--color-ink-3)" }}
      >
        Presence
      </span>
      {q.isLoading && <Spinner size={16} />}
      {q.isError && (
        <p className="text-xs" style={{ color: "var(--color-danger)" }}>
          {shareErrText(q.error)}
        </p>
      )}
      {rows.map((m) => (
        <div key={m.member_id} className="flex items-center gap-2 text-[13px]">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: m.online ? "var(--color-success)" : "var(--color-ink-3)" }}
            aria-label={m.online ? "online" : "offline"}
          />
          <span className="flex-1 truncate" style={{ color: "var(--color-text)" }}>
            {m.name ?? `${m.member_id.slice(0, 8)}…`}
          </span>
          <span className="truncate text-[11px]" style={{ color: "var(--color-ink-3)" }}>
            {/* ponytail: the raw source_id; resolve to the shared paper's title if it grates. */}
            {m.online ? (m.reading ? `reading ${m.reading}` : "online") : seenText(m.last_seen)}
          </span>
        </div>
      ))}
      {q.data && (
        <span className="text-[11px]" style={{ color: "var(--color-ink-3)" }}>
          {rows.length === 0 ? "No other member has synced yet. " : ""}
          Viewer-role members never report presence, so they stay absent here even when online.
        </span>
      )}
    </div>
  );
}
