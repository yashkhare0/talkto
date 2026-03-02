/** Sidebar agent list — click an agent to open a DM channel. */
import { useState } from "react";
import type { Agent } from "@/lib/types";
import { useAppStore } from "@/stores/app-store";
import { useOpenDM, useChannels } from "@/hooks/use-queries";
import { Bot, ChevronRight, Ghost } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarBadge } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Format an ISO timestamp as a relative time string (e.g. "5m ago", "2h ago"). */
function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Map raw agent_type DB values to human-readable labels. */
const AGENT_TYPE_LABELS: Record<string, string> = {
  opencode: "opencode",
  claude_code: "claude",
  codex: "codex",
  system: "system",
};

function agentTypeLabel(agentType: string): string {
  return AGENT_TYPE_LABELS[agentType] ?? agentType;
}

interface AgentListProps {
  agents: Agent[];
  isLoading?: boolean;
  onSelectChannel?: (id: string) => void;
}

export function AgentList({ agents, isLoading, onSelectChannel }: AgentListProps) {
  const agentStatuses = useAppStore((s) => s.agentStatuses);

  if (isLoading) {
    return (
      <div className="px-3">
        <div className="px-0 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
            Agents
          </span>
        </div>
        <div className="space-y-2 py-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-2 px-0 py-1">
              <Skeleton className="h-6 w-6 rounded-full" />
              <Skeleton className="h-3 w-20 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Filter out system agents (e.g. the_creator) — they can't be DM'd
  const dmAgents = agents.filter((a) => a.agent_type !== "system");

  if (dmAgents.length === 0) {
    return (
      <div className="px-3">
        <div className="px-0 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
            Agents
          </span>
        </div>
        <p className="px-0 py-2 text-xs text-sidebar-foreground/30">
          No agents connected yet.
        </p>
      </div>
    );
  }

  // Split into active and ghost agents
  const activeAgents = dmAgents.filter((a) => !a.is_ghost);
  const ghostAgents = dmAgents.filter((a) => a.is_ghost);

  // Sort: online first, then alphabetical
  const sortAgents = (list: Agent[]) =>
    [...list].sort((a, b) => {
      const aStatus = agentStatuses.get(a.agent_name) ?? a.status;
      const bStatus = agentStatuses.get(b.agent_name) ?? b.status;
      if (aStatus === bStatus) return a.agent_name.localeCompare(b.agent_name);
      return aStatus === "online" ? -1 : 1;
    });

  const sortedActive = sortAgents(activeAgents);
  const sortedGhosts = sortAgents(ghostAgents);

  return (
    <div className="px-3">
      <div className="px-0 py-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
          Agents
        </span>
        {sortedActive.length > 0 && (
          <span className="text-[10px] text-sidebar-foreground/30 tabular-nums">
            <span className="text-talkto-online font-medium">
              {sortedActive.filter((a) => (agentStatuses.get(a.agent_name) ?? a.status) === "online").length}
            </span>
            {" / "}
            {sortedActive.length} online
          </span>
        )}
      </div>

      <div className="space-y-0.5">
        <TooltipProvider delayDuration={300}>
          {sortedActive.map((agent) => {
            const status =
              agentStatuses.get(agent.agent_name) ?? agent.status;
            return (
              <AgentItem key={agent.id} agent={agent} status={status} onSelectChannel={onSelectChannel} />
            );
          })}
        </TooltipProvider>
      </div>

      {sortedGhosts.length > 0 && (
        <GhostSection agents={sortedGhosts} onSelectChannel={onSelectChannel} />
      )}
    </div>
  );
}

function GhostSection({ agents, onSelectChannel }: { agents: Agent[]; onSelectChannel?: (id: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const agentStatuses = useAppStore((s) => s.agentStatuses);

  return (
    <div className="mt-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-1.5 px-0 py-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/30 hover:text-sidebar-foreground/50 transition-colors"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            isOpen && "rotate-90",
          )}
        />
        <Ghost className="h-3 w-3" />
        <span>Ghosts ({agents.length})</span>
      </button>

      {isOpen && (
        <div className="space-y-0.5 mt-0.5">
          <TooltipProvider delayDuration={300}>
            {agents.map((agent) => {
              const status =
                agentStatuses.get(agent.agent_name) ?? agent.status;
              return (
                <AgentItem
                  key={agent.id}
                  agent={agent}
                  status={status}
                  isGhost
                  onSelectChannel={onSelectChannel}
                />
              );
            })}
          </TooltipProvider>
        </div>
      )}
    </div>
  );
}

function AgentItem({
  agent,
  status,
  isGhost = false,
  onSelectChannel,
}: {
  agent: Agent;
  status: "online" | "offline";
  isGhost?: boolean;
  onSelectChannel?: (id: string) => void;
}) {
  const isOnline = status === "online" && !isGhost;
  const hasProfile =
    agent.description || agent.personality || agent.current_task || agent.gender;
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const setActiveChannelId = useAppStore((s) => s.setActiveChannelId);
  const { data: channels } = useChannels();
  const openDM = useOpenDM();

  // Check if this agent's DM is currently active
  const dmChannel = channels?.find(
    (c) => c.name === `#dm-${agent.agent_name}`,
  );
  const isActiveDM = dmChannel?.id === activeChannelId;

  const selectFn = onSelectChannel ?? setActiveChannelId;

  const handleClick = () => {
    openDM.mutate(agent.agent_name, {
      onSuccess: (channel) => {
        selectFn(channel.id);
      },
    });
  };

  const item = (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-sm text-left transition-colors",
        isActiveDM
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "hover:bg-sidebar-accent/50",
        openDM.isPending && "opacity-50 pointer-events-none",
        isGhost && "opacity-50",
      )}
    >
      {/* Avatar with status badge — square for agents */}
      <Avatar size="sm" shape="square">
        <AvatarFallback
          className={cn(
            isGhost
              ? "bg-muted text-muted-foreground/20"
              : isOnline
                ? "bg-talkto-agent/12 text-talkto-agent"
                : "bg-muted text-muted-foreground/40",
          )}
        >
          {isGhost ? (
            <Ghost className="h-3.5 w-3.5" />
          ) : (
            <Bot className="h-3.5 w-3.5" />
          )}
        </AvatarFallback>
        <AvatarBadge
          className={cn(
            "ring-sidebar",
            isGhost
              ? "bg-muted-foreground/15"
              : isOnline
                ? "bg-talkto-online"
                : "bg-muted-foreground/30",
          )}
        />
      </Avatar>

      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-xs",
            isGhost
              ? "text-sidebar-foreground/25 line-through"
              : isOnline
                ? "text-sidebar-foreground"
                : "text-sidebar-foreground/40",
          )}
        >
          {agent.agent_name}
        </span>
        {!isGhost && agent.current_task && isOnline && (
          <span className="block truncate text-[10px] text-sidebar-foreground/30 max-w-[140px]">
            {agent.current_task}
          </span>
        )}
        {!isGhost && !isOnline && agent.last_message_at && (
          <span className="block truncate text-[10px] text-sidebar-foreground/20">
            last seen {formatRelativeTime(agent.last_message_at)}
          </span>
        )}
        {!isGhost && !isOnline && !agent.last_message_at && agent.message_count != null && agent.message_count > 0 && (
          <span className="block truncate text-[10px] text-sidebar-foreground/20">
            {agent.message_count} message{agent.message_count !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Agent type badge */}
      <Badge
        variant="outline"
        className={cn(
          "h-4 shrink-0 max-w-[72px] truncate px-1.5 text-[9px] leading-none border-sidebar-border",
          isGhost
            ? "text-sidebar-foreground/15"
            : "text-sidebar-foreground/30",
        )}
        title={agent.agent_type}
      >
        {agentTypeLabel(agent.agent_type)}
      </Badge>
    </button>
  );

  if (!hasProfile) return item;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-64 space-y-1.5 p-3">
        <p className="text-xs font-medium">
          {agent.agent_name}
          {isGhost && (
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/60">
              (ghost)
            </span>
          )}
          {agent.gender && (
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/60">
              {agent.gender === "male"
                ? "he/him"
                : agent.gender === "female"
                  ? "she/her"
                  : "they/them"}
            </span>
          )}
        </p>
        {isGhost && (
          <p className="text-[11px] text-destructive/70">
            Unreachable — process no longer running
          </p>
        )}
        {agent.description && (
          <p className="text-[11px] text-muted-foreground line-clamp-3">
            {agent.description}
          </p>
        )}
        {agent.personality && (
          <p className="text-[11px] italic text-muted-foreground/70 line-clamp-2">
            &ldquo;{agent.personality}&rdquo;
          </p>
        )}
        {agent.current_task && (
          <p className="text-[11px] text-muted-foreground line-clamp-2">
            <span className="font-medium">Working on:</span>{" "}
            {agent.current_task}
          </p>
        )}
        {agent.message_count != null && agent.message_count > 0 && (
          <p className="text-[11px] text-muted-foreground/60">
            <span className="font-medium">{agent.message_count}</span> message{agent.message_count !== 1 ? "s" : ""}
            {agent.last_message_at && (
              <span> · last active {formatRelativeTime(agent.last_message_at)}</span>
            )}
          </p>
        )}
        {!isGhost && Boolean(
          agent.provider_session_id && (
            agent.agent_type === "claude_code" || agent.agent_type === "codex" || agent.server_url
          )
        ) && (
          <p className="text-[11px] text-talkto-agent flex items-center gap-1">
            Invocable — messages reach this agent directly
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
