/** Sidebar channel list. */
import type { Channel } from "@/lib/types";
import { Hash, FolderGit2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

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
  // Filter out DM channels — those are accessed via agent list
  const visibleChannels = channels.filter((c) => c.type !== "dm");
  const generalChannels = visibleChannels.filter((c) => c.type === "general");
  const projectChannels = visibleChannels.filter((c) => c.type === "project");

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
  onClick,
}: {
  channel: Channel;
  isActive: boolean;
  onClick: () => void;
}) {
  const Icon = channel.type === "project" ? FolderGit2 : Hash;

  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn(
        "w-full justify-start gap-2 px-3 py-1.5 h-auto text-sm font-normal",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-sidebar-foreground/70 hover:text-sidebar-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
      <span className="truncate">
        {channel.name.replace(/^#/, "")}
      </span>
    </Button>
  );
}
