/** Sidebar channel list. */
import type { Channel } from "@/lib/types";
import { Hash, FolderGit2, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppStore } from "@/stores/app-store";

interface ChannelListProps {
  channels: Channel[];
  activeChannelId: string | null;
  onSelectChannel: (id: string) => void;
  isLoading?: boolean;
}

export function ChannelList({
  channels,
  activeChannelId,
  onSelectChannel,
  isLoading,
}: ChannelListProps) {
  const starredChannels = useAppStore((s) => s.starredChannels);
  const toggleStarredChannel = useAppStore((s) => s.toggleStarredChannel);

  // Filter out DM channels — those are accessed via agent list
  const visibleChannels = channels.filter((c) => c.type !== "dm");
  const starred = visibleChannels.filter((c) => starredChannels.has(c.id));
  const unstarred = visibleChannels.filter((c) => !starredChannels.has(c.id));
  const generalChannels = unstarred.filter((c) => c.type === "general");
  const projectChannels = unstarred.filter((c) => c.type !== "general");

  if (isLoading) {
    return (
      <div className="space-y-1">
        <div className="px-3 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
            Channels
          </span>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5">
            <Skeleton className="h-3.5 w-3.5 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Section: Starred */}
      {starred.length > 0 && (
        <>
          <div className="px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
              ★ Starred
            </span>
          </div>
          {starred.map((channel) => (
            <ChannelItem
              key={channel.id}
              channel={channel}
              isActive={channel.id === activeChannelId}
              isStarred
              onToggleStar={() => toggleStarredChannel(channel.id)}
              onClick={() => onSelectChannel(channel.id)}
            />
          ))}
        </>
      )}

      {/* Section: Channels */}
      <div className="px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
          Channels
        </span>
      </div>

      {generalChannels.map((channel) => (
        <ChannelItem
          key={channel.id}
          channel={channel}
          isActive={channel.id === activeChannelId}
          isStarred={false}
          onToggleStar={() => toggleStarredChannel(channel.id)}
          onClick={() => onSelectChannel(channel.id)}
        />
      ))}

      {/* Section: Projects */}
      {projectChannels.length > 0 && (
        <>
          <div className="px-3 pb-1 pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
              Projects
            </span>
          </div>

          {projectChannels.map((channel) => (
            <ChannelItem
              key={channel.id}
              channel={channel}
              isActive={channel.id === activeChannelId}
              isStarred={false}
              onToggleStar={() => toggleStarredChannel(channel.id)}
              onClick={() => onSelectChannel(channel.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ChannelItem({
  channel,
  isActive,
  isStarred,
  onToggleStar,
  onClick,
}: {
  channel: Channel;
  isActive: boolean;
  isStarred?: boolean;
  onToggleStar?: () => void;
  onClick: () => void;
}) {
  const isProjectish = channel.type === "project" || channel.name.startsWith("#project-");
  const Icon = isProjectish ? FolderGit2 : Hash;

  return (
    <div className="group/item relative flex items-center">
      <Button
        variant="ghost"
        onClick={onClick}
        className={cn(
          "relative w-full justify-start gap-2 px-3 py-1.5 h-auto text-sm font-normal rounded-md transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
            : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
        )}
      >
        {/* Active indicator — left border accent */}
        {isActive && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-primary" />
        )}
        <Icon className={cn(
          "h-3.5 w-3.5 shrink-0",
          isActive ? "opacity-80" : "opacity-50",
        )} />
        <span className="truncate">
          {channel.name.replace(/^#/, "")}
        </span>
      </Button>
      {onToggleStar && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          className={cn(
            "absolute right-2 rounded p-0.5 transition-colors",
            isStarred
              ? "text-yellow-500 hover:text-yellow-600"
              : "text-transparent group-hover/item:text-sidebar-foreground/30 hover:!text-yellow-500",
          )}
          title={isStarred ? "Unstar channel" : "Star channel"}
        >
          <Star className={cn("h-3 w-3", isStarred && "fill-current")} />
        </button>
      )}
    </div>
  );
}
