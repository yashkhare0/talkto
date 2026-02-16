/** Main workspace layout — Slack-like shell.
 *
 * Left sidebar: channels + agents
 * Main area: message feed (rendered by children)
 * Right panel: feature requests (toggleable)
 */
import { useEffect, useState } from "react";
import { useChannels, useAgents } from "@/hooks/use-queries";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAppStore } from "@/stores/app-store";
import { ChannelList } from "./channel-list";
import { AgentList } from "./agent-list";
import { WorkspaceHeader } from "./workspace-header";
import { FeaturePanel } from "./feature-panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Terminal, Wifi, WifiOff } from "lucide-react";

export function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: channels, isLoading: channelsLoading } = useChannels();
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const setActiveChannelId = useAppStore((s) => s.setActiveChannelId);
  const [featuresOpen, setFeaturesOpen] = useState(false);

  // Connect WebSocket and subscribe to all channels
  const { subscribe } = useWebSocket(true);

  // Auto-select first channel if none selected
  useEffect(() => {
    if (!activeChannelId && channels?.length) {
      const general = channels.find((c) => c.name === "#general");
      setActiveChannelId(general?.id ?? channels[0].id);
    }
  }, [activeChannelId, channels, setActiveChannelId]);

  // Subscribe to all channel IDs via WebSocket
  useEffect(() => {
    if (channels?.length) {
      subscribe(channels.map((c) => c.id));
    }
  }, [channels, subscribe]);

  const activeChannel = channels?.find((c) => c.id === activeChannelId);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* Left sidebar */}
      <aside
        className={`flex h-full flex-col border-r border-border/50 bg-sidebar transition-all duration-200 ${
          sidebarOpen ? "w-64" : "w-0 overflow-hidden"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-sidebar-foreground">
            <Terminal className="h-3.5 w-3.5 text-sidebar" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-sidebar-foreground">
              TalkTo
            </h2>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center">
                {wsConnected ? (
                  <Wifi className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <WifiOff className="h-3.5 w-3.5 text-destructive/70" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{wsConnected ? "Connected — real-time updates active" : "Disconnected — reconnecting..."}</p>
            </TooltipContent>
          </Tooltip>
        </div>

        <Separator className="opacity-50" />

        {/* Channel + Agent lists */}
        <ScrollArea className="flex-1">
          <div className="py-2">
            <ChannelList
              channels={channels ?? []}
              activeChannelId={activeChannelId}
              onSelectChannel={setActiveChannelId}
              isLoading={channelsLoading}
            />

            <div className="px-3 py-3">
              <Separator className="opacity-30" />
            </div>

            <AgentList agents={agents ?? []} isLoading={agentsLoading} />
          </div>
        </ScrollArea>
      </aside>

      {/* Center: main content */}
      <main className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          channel={activeChannel ?? null}
          onToggleFeatures={() => setFeaturesOpen(!featuresOpen)}
          featuresOpen={featuresOpen}
        />
        <div className="flex-1 overflow-hidden">{children}</div>
      </main>

      {/* Right panel: features */}
      {featuresOpen && (
        <aside className="w-80 shrink-0">
          <FeaturePanel onClose={() => setFeaturesOpen(false)} />
        </aside>
      )}
    </div>
  );
}
