import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  inviteMember,
  listMembers,
  rekeyShare,
  removeMember,
  revokeMember,
  setMemberRole,
  transferAdmin,
  type MembersListing,
  type ShareMember,
  shareErrText,
} from "../../api/share";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { OptionSelect } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { relAgo } from "./ShareCard";

const INVITE_ROLE_OPTIONS: { value: "editor" | "viewer"; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];

// THE ADMIN can also promote to co-admin; co-admins only shuffle viewer/editor.
const ADMIN_ROLE_OPTIONS: { value: "editor" | "viewer" | "co-admin"; label: string }[] = [
  ...INVITE_ROLE_OPTIONS,
  { value: "co-admin", label: "Co-admin" },
];

/** Admin-tier e2ee members panel (hosting device or a co-admin's), over the
 * synced roster + local invite sidecar. Controls only offer what the current
 * device's role permits: co-admins manage editors/viewers, THE ADMIN also
 * manages co-admins and can transfer its role. */
export function MembersSection({ shareId, hosted }: { shareId: string; hosted: boolean }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  // Key of whatever was copied last: "new" for the freshly minted string, or a
  // member id for a re-sent one.
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [transferring, setTransferring] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const membersQ = useQuery({
    queryKey: ["share", "members", shareId],
    queryFn: () => listMembers(shareId),
  });
  function invalidateMembers() {
    queryClient.invalidateQueries({ queryKey: ["share", "members", shareId] });
    queryClient.invalidateQueries({ queryKey: ["share", "published"] });
  }
  const inviteM = useMutation({
    mutationFn: () =>
      inviteMember(shareId, {
        memberCode: code.trim(),
        role,
        name: name.trim() || undefined,
      }),
    onSuccess: (inv) => {
      setInvite(inv);
      setCopied(null);
      setCode("");
      setName("");
      invalidateMembers();
    },
  });
  const revokeM = useMutation({
    mutationFn: (memberId: string) => revokeMember(shareId, memberId),
    onSuccess: () => {
      setRevoking(null);
      invalidateMembers();
    },
  });
  const rekeyM = useMutation({
    mutationFn: () => rekeyShare(shareId),
    onSuccess: invalidateMembers,
  });
  // The rollback arm: revoke + drop the row, so re-inviting the same device
  // does not inherit a stale role or a dead invite string.
  const removeM = useMutation({
    mutationFn: (memberId: string) => removeMember(shareId, memberId),
    onSuccess: () => {
      setRemoving(null);
      invalidateMembers();
    },
  });
  // §3.3 viewer ↔ editor dropdown: optimistic flip, rolled back on error
  // (the error line below is the page's toast equivalent).
  const roleM = useMutation({
    mutationFn: ({
      memberId,
      role,
    }: {
      memberId: string;
      role: "editor" | "viewer" | "co-admin";
    }) => setMemberRole(shareId, memberId, role),
    onMutate: async ({ memberId, role }) => {
      await queryClient.cancelQueries({ queryKey: ["share", "members", shareId] });
      const prev = queryClient.getQueryData<MembersListing>(["share", "members", shareId]);
      queryClient.setQueryData<MembersListing>(["share", "members", shareId], (listing) =>
        listing && {
          ...listing,
          members: listing.members.map((m) =>
            m.member_id === memberId ? { ...m, role } : m
          ),
        }
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["share", "members", shareId], ctx.prev);
    },
    onSettled: () => invalidateMembers(),
  });
  // THE-ADMIN handover: the marker moves, this device demotes to co-admin.
  const transferM = useMutation({
    mutationFn: (memberId: string) => transferAdmin(shareId, memberId),
    onSuccess: () => {
      setTransferring(null);
      invalidateMembers();
    },
  });

  async function handleCopy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (!alive.current) return;
      setCopied(key);
      setTimeout(() => {
        if (alive.current) setCopied((c) => (c === key ? null : c));
      }, 1500);
    } catch {
      // Clipboard write denied.
    }
  }

  const listing = membersQ.data;
  const members = listing?.members ?? [];
  const selfRole = listing?.self_role;
  const selfId = listing?.self_member_id;
  // What this device's role may touch: THE ADMIN manages everyone but itself
  // (it transfers, never demotes itself); a co-admin only editors/viewers.
  const manageable = (m: ShareMember) =>
    !m.revoked &&
    m.member_id !== "" &&
    m.member_id !== selfId &&
    m.role !== "admin" &&
    (selfRole === "admin" || m.role !== "co-admin");
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <span
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink3"
      >
        Members
      </span>
      {membersQ.isLoading && <Spinner size={16} />}
      {hosted && members.some((m) => m.member_id !== selfId && !m.revoked) && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-ink3">
            {rekeyM.isSuccess
              ? `Re-keyed for ${rekeyM.data.members} member${rekeyM.data.members === 1 ? "" : "s"}. They should sync again.`
              : "If a member syncs but stays empty, re-key: their invite came after this content was encrypted."}
          </span>
          <Button
            variant="muted"
            size="sm"
            onClick={() => rekeyM.mutate()}
            disabled={rekeyM.isPending}
          >
            {rekeyM.isPending ? <Spinner size={14} /> : "Re-key"}
          </Button>
        </div>
      )}
      {rekeyM.isError && (
        <p className="text-xs text-danger">
          {shareErrText(rekeyM.error)}
        </p>
      )}
      {members.map((m) => (
        <div key={m.member_id || m.invited_at} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              className={`flex-1 truncate text-[13px] ${m.revoked ? "text-ink3" : "text-text"}`}
            >
              {m.member_id === selfId
                ? "This device"
                : m.name || m.member_id.slice(0, 8) || "unknown device"}
            </span>
            {manageable(m) && m.verified ? (
              <OptionSelect
                aria-label={`Role for ${m.name || m.member_id.slice(0, 8)}`}
                size="sm"
                value={m.role as "editor" | "viewer" | "co-admin"}
                onChange={(r) => roleM.mutate({ memberId: m.member_id, role: r })}
                disabled={roleM.isPending}
                options={selfRole === "admin" ? ADMIN_ROLE_OPTIONS : INVITE_ROLE_OPTIONS}
              />
            ) : (
              <span
                className="shrink-0 rounded-full border border-border bg-surface2 px-2 py-0.5 font-mono text-[10px] font-semibold text-muted"
              >
                {m.revoked ? "revoked" : m.verified ? m.role : `${m.role} (unverified)`}
              </span>
            )}
            {selfRole === "admin" && m.role === "co-admin" && !m.revoked && (
              <Button
                variant={transferring === m.member_id ? "danger" : "ghost"}
                size="sm"
                disabled={transferM.isPending}
                onClick={() => {
                  if (transferring !== m.member_id) return setTransferring(m.member_id);
                  transferM.mutate(m.member_id);
                }}
              >
                {transferM.isPending && transferring === m.member_id ? (
                  <Spinner size={14} />
                ) : transferring === m.member_id ? (
                  "Confirm transfer"
                ) : (
                  "Make admin"
                )}
              </Button>
            )}
            {transferring === m.member_id && !transferM.isPending && (
              <Button
                variant="muted"
                size="sm"
                onClick={() => setTransferring(null)}
              >
                Cancel
              </Button>
            )}
            {manageable(m) && revoking === m.member_id && (
              <Button
                variant="muted"
                size="sm"
                disabled={revokeM.isPending}
                onClick={() => setRevoking(null)}
              >
                Cancel
              </Button>
            )}
            {manageable(m) && (
              <Button
                variant={revoking === m.member_id ? "danger" : "ghost"}
                size="sm"
                disabled={revokeM.isPending}
                onClick={() => {
                  if (revoking !== m.member_id) return setRevoking(m.member_id);
                  inviteM.reset();
                  revokeM.mutate(m.member_id);
                }}
              >
                {revokeM.isPending && revoking === m.member_id ? (
                  <Spinner size={14} />
                ) : revoking === m.member_id ? (
                  "Confirm revoke"
                ) : (
                  "Revoke"
                )}
              </Button>
            )}
          </div>
          {m.member_id !== selfId && (
            // Outstanding-invite line: a member who never picks theirs up leaves
            // no other trace on this end, and the string is otherwise shown once.
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink3">
                Invited {relAgo(m.invited_at)}
                {m.revoked
                  ? " · revoked"
                  : m.verified
                    ? ""
                    : " · not confirmed by the key layer yet"}
              </span>
              <div className="flex-1" />
              {!m.revoked && m.invite && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy(m.member_id, m.invite as string)}
                >
                  {copied === m.member_id ? "Copied" : "Copy invite"}
                </Button>
              )}
              {removing === m.member_id && (
                <Button
                  variant="muted"
                  size="sm"
                  disabled={removeM.isPending}
                  onClick={() => setRemoving(null)}
                >
                  Cancel
                </Button>
              )}
              {m.member_id !== "" && (m.revoked || manageable(m)) && (
                <Button
                  variant={removing === m.member_id ? "danger" : "ghost"}
                  size="sm"
                  disabled={removeM.isPending}
                  onClick={() => {
                    if (removing !== m.member_id) return setRemoving(m.member_id);
                    inviteM.reset();
                    removeM.mutate(m.member_id);
                  }}
                >
                  {removeM.isPending && removing === m.member_id ? (
                    <Spinner size={14} />
                  ) : removing === m.member_id ? (
                    "Confirm remove"
                  ) : (
                    "Remove"
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      {revoking != null && (
        <p className="text-xs text-muted">
          Stops receiving future updates. Content already synced stays on their
          device.
        </p>
      )}
      {removing != null && (
        <p className="text-xs text-muted">
          Revokes them and forgets the invite entirely, so re-inviting the same
          device starts clean. They should also leave the share on their end.
        </p>
      )}
      {transferring != null && (
        <p className="text-xs text-muted">
          Hands THE ADMIN role to this co-admin. This device becomes a
          co-admin{hosted ? "; hosting stays here" : "; hosting is unaffected"}.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Member code"
          className="flex-1 font-mono"
          placeholder="Paste their member code…"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <OptionSelect
          aria-label="Invite role"
          size="sm"
          value={role}
          onChange={setRole}
          options={INVITE_ROLE_OPTIONS}
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Member name"
          className="flex-1"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            revokeM.reset();
            inviteM.mutate();
          }}
          disabled={inviteM.isPending || !code.trim()}
        >
          {inviteM.isPending ? <Spinner size={14} /> : "Invite"}
        </Button>
      </div>
      {(inviteM.isError ||
        revokeM.isError ||
        removeM.isError ||
        roleM.isError ||
        transferM.isError ||
        membersQ.isError) && (
        <p className="text-xs text-danger">
          {shareErrText(
            inviteM.error ??
              revokeM.error ??
              removeM.error ??
              roleM.error ??
              transferM.error ??
              membersQ.error
          )}
        </p>
      )}
      {invite && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink3"
            >
              Invite string — send it to them
            </span>
            <Button variant="muted" size="sm" onClick={() => handleCopy("new", invite)}>
              {copied === "new" ? "Copied" : "Copy"}
            </Button>
          </div>
          <Textarea
            readOnly
            value={invite}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
