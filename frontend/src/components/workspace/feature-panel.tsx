/** Feature requests panel — slide-out or embedded view. */
import { useState } from "react";
import {
  useFeatures,
  useCreateFeature,
  useVoteFeature,
} from "@/hooks/use-queries";
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
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Feature } from "@/lib/types";

interface FeaturePanelProps {
  onClose: () => void;
}

export function FeaturePanel({ onClose }: FeaturePanelProps) {
  const { data: features, isLoading } = useFeatures();
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex h-full flex-col border-l border-border/50 bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold">Feature Requests</h2>
          {features && (
            <Badge variant="secondary" className="text-[10px]">
              {features.length}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowForm(!showForm)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Separator className="opacity-50" />

      {/* New feature form */}
      {showForm && (
        <div className="border-b border-border/50 px-4 py-3">
          <CreateFeatureForm onDone={() => setShowForm(false)} />
        </div>
      )}

      {/* Feature list */}
      <ScrollArea className="flex-1">
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
    </div>
  );
}

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

function FeatureItem({ feature }: { feature: Feature }) {
  const voteFeature = useVoteFeature();

  const statusColor: Record<string, string> = {
    open: "bg-emerald-500/10 text-emerald-600",
    planned: "bg-blue-500/10 text-blue-600",
    "in-progress": "bg-amber-500/10 text-amber-600",
    done: "bg-muted text-muted-foreground",
  };

  return (
    <div className="group rounded-md border border-border/30 bg-card/50 p-3 transition-colors hover:border-border/60">
      <div className="flex items-start gap-2">
        {/* Vote controls */}
        <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground/40 hover:text-foreground"
            onClick={() =>
              voteFeature.mutate({ featureId: feature.id, vote: 1 })
            }
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              feature.vote_count > 0
                ? "text-emerald-600"
                : feature.vote_count < 0
                  ? "text-red-500"
                  : "text-muted-foreground/50",
            )}
          >
            {feature.vote_count}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground/40 hover:text-foreground"
            onClick={() =>
              voteFeature.mutate({ featureId: feature.id, vote: -1 })
            }
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-xs font-medium text-foreground">
              {feature.title}
            </h3>
            <Badge
              variant="secondary"
              className={cn(
                "h-4 text-[9px] px-1.5",
                statusColor[feature.status] ?? "",
              )}
            >
              {feature.status}
            </Badge>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/70">
            {feature.description}
          </p>
        </div>
      </div>
    </div>
  );
}
