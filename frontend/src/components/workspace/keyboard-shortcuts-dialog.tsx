/** Modal dialog showing available keyboard shortcuts. */
import { useEffect } from "react";
import { X } from "lucide-react";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: ["⌘", "K"], description: "Search messages" },
  { keys: ["⌘", "B"], description: "Toggle sidebar" },
  { keys: ["⌘", "⇧", "F"], description: "Toggle features panel" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
  { keys: ["Esc"], description: "Close panels / cancel" },
  { keys: ["Enter"], description: "Send message" },
  { keys: ["⇧", "Enter"], description: "New line in message" },
  { keys: ["↑", "↓"], description: "Navigate mention suggestions" },
  { keys: ["Tab"], description: "Accept mention suggestion" },
] as const;

export function KeyboardShortcutsDialog({ open, onClose }: KeyboardShortcutsDialogProps) {
  // Close on escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, { capture: true });
    return () => window.removeEventListener("keydown", handleKey, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xl animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2">
          {SHORTCUTS.map(({ keys, description }) => (
            <div
              key={description}
              className="flex items-center justify-between py-1"
            >
              <span className="text-sm text-foreground/80">{description}</span>
              <div className="flex items-center gap-1">
                {keys.map((key) => (
                  <kbd
                    key={key}
                    className="inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-border bg-muted px-1.5 text-[11px] font-medium text-muted-foreground"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[11px] text-muted-foreground/50">
          ⌘ = Cmd on Mac, Ctrl on Windows/Linux
        </p>
      </div>
    </div>
  );
}
