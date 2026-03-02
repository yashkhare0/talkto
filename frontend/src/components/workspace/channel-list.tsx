/** Sidebar channel list. */
import type { Channel } from "@/lib/types";
import { Hash, FolderGit2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUnreadCounts } from "@/hooks/use-queries";

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
  const { data: unreadCounts } = useUnreadCounts();
  const unreadMap = new Map(
    (unreadCounts ?? []).map((u) => [u.channel_id, u.unread_count])
  );

  // Filter out DM channels — those are accessed via agent list
  const visibleChannels = channels.filter((c) => c.type !== "dm");
  const generalChannels = visibleChannels.filter((c) => c.type === "general");
  const projectChannels = visibleChannels.filter((c) => c.type !== "general");

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
          unreadCount={unreadMap.get(channel.id) ?? 0}
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
              unreadCount={unreadMap.get(channel.id) ?? 0}
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
  unreadCount = 0,
  onClick,
}: {
  channel: Channel;
  isActive: boolean;
  unreadCount?: number;
  onClick: () => void;
}) {
  const isProjectish = channel.type === "project" || channel.name.startsWith("#project-");
  const Icon = isProjectish ? FolderGit2 : Hash;
  const hasUnread = unreadCount > 0 && !isActive;

  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn(
        "relative w-full justify-start gap-2 px-3 py-1.5 h-auto text-sm font-normal rounded-md transition-colors",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : hasUnread
            ? "text-sidebar-foreground font-semibold hover:bg-sidebar-accent/50"
            : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
    >
      {/* Active indicator — left border accent */}
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-primary" />
      )}
      <Icon className={cn(
        "h-3.5 w-3.5 shrink-0",
        isActive ? "opacity-80" : hasUnread ? "opacity-90" : "opacity-50",
      )} />
      <span className="truncate">
        {channel.name.replace(/^#/, "")}
      </span>
      {hasUnread && (
        <span className="ml-auto shrink-0 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </Button>
  );
}
