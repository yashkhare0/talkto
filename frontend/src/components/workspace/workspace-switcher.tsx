/** Workspace switcher dropdown for the sidebar.
 *
 * Shows the active workspace name with a chevron. Clicking opens a dropdown
 * listing all workspaces with type badges and a "Create Workspace" form.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaces, useCreateWorkspace } from "@/hooks/use-queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const setActiveWorkspaceId = useAppStore((s) => s.setActiveWorkspaceId);

  const queryClient = useQueryClient();
  const { data: fetchedWorkspaces } = useWorkspaces();
  const createWorkspace = useCreateWorkspace();

  const allWorkspaces = fetchedWorkspaces ?? workspaces;
  const activeWorkspace = allWorkspaces.find((w) => w.id === activeWorkspaceId);
  const displayName = activeWorkspace?.name ?? "Select Workspace";

  function handleSelect(id: string) {
    if (id === activeWorkspaceId) {
      setOpen(false);
      return;
    }
    setActiveWorkspaceId(id);
    setOpen(false);
    setShowCreate(false);
    // Clear all cached queries so they refetch under the new workspace context
    queryClient.clear();
  }

  function handleCreate() {
    if (!name.trim() || !slug.trim()) return;
    createWorkspace.mutate(
      { name: name.trim(), slug: slug.trim() },
      {
        onSuccess: (ws) => {
          setName("");
          setSlug("");
          setShowCreate(false);
          if (ws?.id) handleSelect(ws.id);
        },
      },
    );
  }

  return (
    <div className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5",
          "text-sm font-semibold",
          "hover:bg-zinc-100 dark:hover:bg-zinc-800",
          "transition-colors",
        )}
      >
        <span className="truncate">{displayName}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          className={cn(
            "shrink-0 transition-transform",
            open && "rotate-180",
          )}
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => {
            setOpen(false);
            setShowCreate(false);
          }}
        />
      )}

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            "absolute left-0 top-full z-50 mt-1 w-64",
            "rounded-lg border border-zinc-200 bg-white shadow-lg",
            "dark:border-zinc-700 dark:bg-zinc-900",
          )}
        >
          <div className="max-h-60 overflow-y-auto p-1">
            {allWorkspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => handleSelect(ws.id)}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-2",
                  "text-left text-sm transition-colors",
                  "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                  ws.id === activeWorkspaceId &&
                    "bg-zinc-100 dark:bg-zinc-800",
                )}
              >
                <span className="truncate font-medium">{ws.name}</span>
                <span
                  className={cn(
                    "ml-2 shrink-0 rounded px-1.5 py-0.5 text-xs",
                    ws.type === "personal"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                      : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
                  )}
                >
                  {ws.type}
                </span>
              </button>
            ))}
            {allWorkspaces.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-zinc-500">
                No workspaces found
              </p>
            )}
          </div>

          <div className="border-t border-zinc-200 p-1 dark:border-zinc-700">
            {showCreate ? (
              <div className="space-y-2 p-2">
                <Input
                  placeholder="Workspace name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 text-sm"
                  autoFocus
                />
                <Input
                  placeholder="slug (url-friendly)"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="h-8 text-sm"
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 flex-1 text-xs"
                    onClick={() => {
                      setShowCreate(false);
                      setName("");
                      setSlug("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 flex-1 text-xs"
                    disabled={!name.trim() || !slug.trim() || createWorkspace.isPending}
                    onClick={handleCreate}
                  >
                    {createWorkspace.isPending ? "Creating..." : "Create"}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2.5 py-2",
                  "text-sm text-zinc-600 transition-colors",
                  "hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  className="shrink-0"
                >
                  <path
                    d="M7 3V11M3 7H11"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                Create Workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
