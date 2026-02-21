/** Feature requests panel — right-side Sheet overlay with management actions. */
import { useState, useRef, useEffect, useCallback } from "react";
import {
  useFeatures,
  useCreateFeature,
  useVoteFeature,
  useUpdateFeature,
  useDeleteFeature,
} from "@/hooks/use-queries";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronUp,
  ChevronDown,
  Plus,
  Lightbulb,
  MoreVertical,
  Check,
  X,
  Ban,
  Trash2,
  Clock,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Feature } from "@/lib/types";

// ── Status config ───────────────────────────────────────

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  open: { color: "bg-talkto-success/10 text-talkto-success", label: "open" },
  planned: { color: "bg-blue-500/10 text-blue-500", label: "planned" },
  in_progress: { color: "bg-amber-500/10 text-amber-500", label: "in progress" },
  done: { color: "bg-muted text-muted-foreground", label: "done" },
  closed: { color: "bg-muted text-muted-foreground/60", label: "closed" },
  wontfix: { color: "bg-red-500/8 text-red-400", label: "won't fix" },
};

// ── Panel ───────────────────────────────────────────────

interface FeaturePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeaturePanel({ open, onOpenChange }: FeaturePanelProps) {
  const { data: features, isLoading } = useFeatures();
  const [showForm, setShowForm] = useState(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col overflow-hidden">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4 text-talkto-warning" />
            Feature Requests
            {features && (
              <Badge variant="secondary" className="text-[10px]">
                {features.length}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            Vote on what gets built next. Agents can submit and vote too.
          </SheetDescription>
        </SheetHeader>

        <Separator className="opacity-50" />

        {/* Add feature toggle */}
        <div className="flex items-center justify-end px-4">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-muted-foreground"
            onClick={() => setShowForm(!showForm)}
          >
            <Plus className="h-3.5 w-3.5" />
            {showForm ? "Cancel" : "New Request"}
          </Button>
        </div>

        {/* New feature form */}
        {showForm && (
          <div className="border-b border-border/50 px-4 pb-3">
            <CreateFeatureForm onDone={() => setShowForm(false)} />
          </div>
        )}

        {/* Feature list */}
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="space-y-1 p-2">
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-md border border-border/30 p-3 flex items-start gap-2"
                >
                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <Skeleton className="h-3.5 w-3.5 rounded" />
                    <Skeleton className="h-3 w-4 rounded" />
                    <Skeleton className="h-3.5 w-3.5 rounded" />
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}

            {features?.map((feature) => (
              <FeatureItem key={feature.id} feature={feature} />
            ))}

            {!isLoading && features?.length === 0 && (
              <p className="px-2 py-8 text-center text-xs text-muted-foreground/50">
                No feature requests yet. Create one!
              </p>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ── Create form ─────────────────────────────────────────

function CreateFeatureForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const createFeature = useCreateFeature();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    try {
      await createFeature.mutateAsync({
        title: title.trim(),
        description: description.trim(),
      });
      setTitle("");
      setDescription("");
      onDone();
    } catch {
      // Error shown via mutation state
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Input
        placeholder="Feature title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="h-8 text-xs"
        autoFocus
      />
      <Textarea
        placeholder="Describe the feature..."
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="min-h-[60px] text-xs resize-none"
        rows={2}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-7 text-xs"
          disabled={!title.trim() || !description.trim() || createFeature.isPending}
        >
          Submit
        </Button>
      </div>
    </form>
  );
}

// ── Feature item ────────────────────────────────────────

function FeatureItem({ feature }: { feature: Feature }) {
  const voteFeature = useVoteFeature();
  const updateFeature = useUpdateFeature();
  const deleteFeature = useDeleteFeature();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reasonPrompt, setReasonPrompt] = useState<string | null>(null); // status waiting for reason
  const [reasonText, setReasonText] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const cfg = STATUS_CONFIG[feature.status] ?? STATUS_CONFIG.open;
  const isClosed = feature.status === "done" || feature.status === "closed" || feature.status === "wontfix";

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(false);
        setReasonPrompt(null);
        setReasonText("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const handleStatusChange = useCallback(
    (status: string) => {
      // For close/wontfix, prompt for reason
      if (status === "closed" || status === "wontfix") {
        setReasonPrompt(status);
        return;
      }
      updateFeature.mutate({ featureId: feature.id, status });
      setMenuOpen(false);
    },
    [feature.id, updateFeature],
  );

  const handleReasonSubmit = useCallback(() => {
    if (!reasonPrompt) return;
    updateFeature.mutate({
      featureId: feature.id,
      status: reasonPrompt,
      reason: reasonText.trim() || undefined,
    });
    setMenuOpen(false);
    setReasonPrompt(null);
    setReasonText("");
  }, [feature.id, reasonPrompt, reasonText, updateFeature]);

  const handleDelete = useCallback(() => {
    deleteFeature.mutate({ featureId: feature.id });
    setMenuOpen(false);
    setConfirmDelete(false);
  }, [feature.id, deleteFeature]);

  return (
    <div className="group relative rounded-md border border-border/30 bg-card/50 p-3 transition-colors hover:border-border/60">
      <div className="flex items-start gap-2">
        {/* Vote controls */}
        <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground/40 hover:text-foreground"
            onClick={() => voteFeature.mutate({ featureId: feature.id, vote: 1 })}
            disabled={isClosed}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              feature.vote_count > 0
                ? "text-talkto-success"
                : feature.vote_count < 0
                  ? "text-talkto-danger"
                  : "text-muted-foreground/50",
            )}
          >
            {feature.vote_count}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground/40 hover:text-foreground"
            onClick={() => voteFeature.mutate({ featureId: feature.id, vote: -1 })}
            disabled={isClosed}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className={cn(
              "truncate text-xs font-medium",
              isClosed ? "text-muted-foreground/60 line-through" : "text-foreground",
            )}>
              {feature.title}
            </h3>
            <Badge
              variant="secondary"
              className={cn("h-4 text-[9px] px-1.5 shrink-0", cfg.color)}
            >
              {cfg.label}
            </Badge>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/70">
            {feature.description}
          </p>
          {/* Reason display */}
          {feature.reason && (
            <p className="mt-1 text-[10px] italic text-muted-foreground/50">
              Reason: {feature.reason}
            </p>
          )}
        </div>

        {/* Action menu trigger */}
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
            setConfirmDelete(false);
            setReasonPrompt(null);
            setReasonText("");
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-foreground"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Action menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-2 top-8 z-50 w-44 rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in slide-in-from-top-1 duration-100"
        >
          {/* Reason prompt mode */}
          {reasonPrompt && (
            <div className="space-y-1.5 p-1">
              <p className="text-[10px] font-medium text-muted-foreground">
                {reasonPrompt === "wontfix" ? "Won't fix" : "Close"} — reason (optional):
              </p>
              <Input
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="Why?"
                className="h-7 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleReasonSubmit();
                  if (e.key === "Escape") { setReasonPrompt(null); setReasonText(""); }
                }}
              />
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => { setReasonPrompt(null); setReasonText(""); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={handleReasonSubmit}
                  disabled={updateFeature.isPending}
                >
                  {updateFeature.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                </Button>
              </div>
            </div>
          )}

          {/* Delete confirmation mode */}
          {!reasonPrompt && confirmDelete && (
            <div className="space-y-1.5 p-1">
              <p className="text-[10px] font-medium text-destructive">
                Delete permanently?
              </p>
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={handleDelete}
                  disabled={deleteFeature.isPending}
                >
                  {deleteFeature.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Delete"}
                </Button>
              </div>
            </div>
          )}

          {/* Normal action buttons */}
          {!reasonPrompt && !confirmDelete && (
            <>
              {feature.status !== "done" && (
                <MenuButton
                  icon={<Check className="h-3 w-3" />}
                  label="Resolve"
                  onClick={() => handleStatusChange("done")}
                />
              )}
              {feature.status !== "planned" && feature.status !== "done" && (
                <MenuButton
                  icon={<Clock className="h-3 w-3" />}
                  label="Mark Planned"
                  onClick={() => handleStatusChange("planned")}
                />
              )}
              {feature.status !== "in_progress" && feature.status !== "done" && (
                <MenuButton
                  icon={<Loader2 className="h-3 w-3" />}
                  label="Mark In Progress"
                  onClick={() => handleStatusChange("in_progress")}
                />
              )}
              {feature.status !== "open" && (
                <MenuButton
                  icon={<Lightbulb className="h-3 w-3" />}
                  label="Reopen"
                  onClick={() => handleStatusChange("open")}
                />
              )}
              {feature.status !== "closed" && (
                <MenuButton
                  icon={<X className="h-3 w-3" />}
                  label="Close"
                  onClick={() => handleStatusChange("closed")}
                  className="text-muted-foreground/70"
                />
              )}
              {feature.status !== "wontfix" && (
                <MenuButton
                  icon={<Ban className="h-3 w-3" />}
                  label="Won't Fix"
                  onClick={() => handleStatusChange("wontfix")}
                  className="text-muted-foreground/70"
                />
              )}
              <Separator className="my-1 opacity-30" />
              <MenuButton
                icon={<Trash2 className="h-3 w-3" />}
                label="Delete"
                onClick={() => setConfirmDelete(true)}
                className="text-destructive hover:!text-destructive"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Menu button ─────────────────────────────────────────

function MenuButton({
  icon,
  label,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent",
        className,
      )}
    >
      {icon}
      {label}
    </button>
  );
}
