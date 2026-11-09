import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createShareTicket, publishSecure, shareErrText } from "../../api/share";
import { createProjectLocal, listProjectsLocal } from "../../api/projects";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import { OptionSelect } from "../ui/select";
import { Spinner } from "../ui/spinner";

const SHARE_MODE_OPTIONS: { value: "plain" | "e2ee"; label: string }[] = [
  { value: "plain", label: "Plain ticket" },
  { value: "e2ee", label: "End-to-end encrypted" },
];

/** Sentinel value in the project select for "create a new project first". */
const NEW_PROJECT = "new";

export function ShareProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"plain" | "e2ee">("plain");
  const [ticket, setTicket] = useState("");
  const [secured, setSecured] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const genTokenRef = useRef(0);
  // Last inline-created project, so a re-click after a mid-flight reset (or a
  // share failure) reuses it instead of minting a duplicate. createReqRef
  // covers the in-flight window before the create resolves: a re-click then
  // awaits the same request instead of firing a second one.
  const createdRef = useRef<{ name: string; id: number } | null>(null);
  const createReqRef = useRef<{ name: string; promise: Promise<number> } | null>(null);
  // Bumped on close so a create resolving after the dialog session ended
  // can't repopulate createdRef past handleClose's reset.
  const dialogSessionRef = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { data } = useQuery({
    // Local-only: sharing publishes from the local library, so the picker
    // must not follow the default-backend routing (distinct query key).
    queryKey: ["projects", "active", "local"],
    queryFn: () => listProjectsLocal("active"),
    enabled: open,
  });
  const projects = data?.projects ?? [];

  function resetTicketState() {
    genTokenRef.current++;
    setTicket("");
    setSecured(false);
    setError("");
    setCopied(false);
    setGenerating(false);
  }

  async function handleGenerate() {
    const creating = selected === NEW_PROJECT;
    let id = Number(selected);
    if (generating || (creating ? !newName.trim() : !id)) return;
    const token = ++genTokenRef.current;
    setGenerating(true);
    setError("");
    setTicket("");
    setSecured(false);
    setCopied(false);
    try {
      if (creating) {
        const nm = newName.trim();
        let created = createdRef.current?.name === nm ? createdRef.current.id : null;
        if (created == null) {
          let req =
            createReqRef.current?.name === nm ? createReqRef.current.promise : null;
          if (req == null) {
            const session = dialogSessionRef.current;
            req = createProjectLocal({ name: nm }).then((res) => {
              if (dialogSessionRef.current === session) {
                createdRef.current = { name: nm, id: res.project.id };
              }
              queryClient.invalidateQueries({ queryKey: ["projects"] });
              return res.project.id;
            });
            createReqRef.current = { name: nm, promise: req };
            req.finally(() => {
              if (createReqRef.current?.promise === req) createReqRef.current = null;
            });
          }
          created = await req;
        }
        if (genTokenRef.current !== token || !alive.current) return;
        id = created;
        // Point the select at the created project so a retry after a share
        // failure doesn't create a duplicate.
        setSelected(String(id));
        setNewName("");
      }
      if (mode === "e2ee") {
        await publishSecure(id);
        if (genTokenRef.current !== token || !alive.current) return;
        setSecured(true);
      } else {
        const t = await createShareTicket(id);
        if (genTokenRef.current !== token || !alive.current) return;
        setTicket(t);
      }
      // Publishing (either mode) grows the Hoster grid. The share succeeded,
      // so the create-dedupe is spent: a future same-named "New project" is a
      // genuinely new project, not a reuse.
      createdRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["share", "published"] });
    } catch (e) {
      if (genTokenRef.current !== token || !alive.current) return;
      setError(shareErrText(e));
    } finally {
      if (genTokenRef.current === token && alive.current) setGenerating(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(ticket);
      if (!alive.current) return;
      setCopied(true);
      setTimeout(() => {
        if (alive.current) setCopied(false);
      }, 1500);
    } catch {
      // Clipboard denied: the ticket is still selectable in the textarea.
    }
  }

  function handleClose() {
    resetTicketState();
    setSelected("");
    setNewName("");
    // The dedupe only guards retries within one dialog session; a project
    // created earlier could be deleted while the dialog is closed.
    createdRef.current = null;
    dialogSessionRef.current++;
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} title="Share a project">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted">
          {mode === "e2ee"
            ? "Publish an encrypted copy of the project. There is no ticket. You may generate an invite string for each member from the share's settings using their member code."
            : "Generate a ticket, then paste it in linXiv on another computer to send a read-only copy of the project."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <OptionSelect
            aria-label="Project to share"
            size="sm"
            placeholder="Select a project…"
            value={selected}
            onChange={(v) => {
              setSelected(v);
              resetTicketState();
            }}
            options={[
              { value: NEW_PROJECT, label: "＋ New project…" },
              ...projects.map((p) => ({ value: String(p.id), label: p.name })),
            ]}
          />
          {selected === NEW_PROJECT && (
            <Input
              aria-label="New project name"
              className="flex-1 min-w-[140px]"
              placeholder="New project name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
            />
          )}
          <OptionSelect
            aria-label="Share mode"
            size="sm"
            value={mode}
            onChange={(v) => {
              setMode(v);
              resetTicketState();
            }}
            options={SHARE_MODE_OPTIONS}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleGenerate}
            disabled={
              generating ||
              !selected ||
              (selected === NEW_PROJECT && !newName.trim())
            }
          >
            {generating ? (
              <Spinner size={14} />
            ) : mode === "e2ee" ? (
              "Publish encrypted"
            ) : (
              "Create ticket"
            )}
          </Button>
        </div>
        {error && (
          <p className="text-xs text-danger">
            {error}
          </p>
        )}
        {secured && (
          <p className="text-xs text-muted">
            Published encrypted. Open the share's settings to invite members —
            each device sends you its member code first.
          </p>
        )}
        {ticket && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span
                className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink3"
              >
                Invite ticket
              </span>
              <Button variant="muted" size="sm" onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Textarea readOnly value={ticket} rows={3} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
