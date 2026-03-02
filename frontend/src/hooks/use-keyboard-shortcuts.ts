/** Global keyboard shortcuts — Slack-like key bindings. */
import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";

interface ShortcutHandlers {
  onToggleSearch?: () => void;
  onCloseSearch?: () => void;
  onToggleSidebar?: () => void;
  onToggleFeatures?: () => void;
  onToggleShortcutsHelp?: () => void;
}

/**
 * Register global keyboard shortcuts:
 * - Cmd/Ctrl+K → toggle search
 * - Cmd/Ctrl+B → toggle sidebar
 * - Cmd/Ctrl+Shift+F → toggle features panel
 * - Cmd/Ctrl+/ → show shortcut help (future)
 * - Escape → close open panels
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers = {}) {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Don't intercept when typing in input/textarea (unless it's Escape)
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (e.key === "Escape") {
        // Escape always works — close panels, clear search, etc.
        // Use dedicated close handler if available (avoids reopening)
        if (handlers.onCloseSearch) {
          handlers.onCloseSearch();
        }
        return;
      }

      if (isInput) return;

      // Cmd+K → search
      if (mod && e.key === "k") {
        e.preventDefault();
        handlers.onToggleSearch?.();
        return;
      }

      // Cmd+B → toggle sidebar
      if (mod && e.key === "b") {
        e.preventDefault();
        if (handlers.onToggleSidebar) {
          handlers.onToggleSidebar();
        } else {
          toggleSidebar();
        }
        return;
      }

      // Cmd+Shift+F → toggle features
      if (mod && e.shiftKey && e.key === "F") {
        e.preventDefault();
        handlers.onToggleFeatures?.();
        return;
      }

      // ? → show shortcuts help
      if (e.key === "?" && !e.shiftKey && !mod) {
        e.preventDefault();
        handlers.onToggleShortcutsHelp?.();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlers, toggleSidebar]);
}
