import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { X } from "lucide-react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Dialog({ open, onClose, title, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-in fade-in"
        />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl p-6 shadow-2xl animate-in fade-in zoom-in-95"
          style={{
            backgroundColor: "var(--color-panel)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <RadixDialog.Title
              className="text-base font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <button
                onClick={onClose}
                className="rounded p-1 transition-colors hover:bg-[var(--color-border)]"
                style={{ color: "var(--color-muted)" }}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
