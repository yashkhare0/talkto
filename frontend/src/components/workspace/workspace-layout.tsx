/** Main workspace layout — Slack-like shell.
 *
 * Left sidebar: channels + agents
 * Main area: message feed (rendered by children)
 * Right panel: feature requests (toggleable)
 *
 * URL sync: ?channel=general | ?channel=dm-agentname | ?channel=project-foo
 */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
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
import { Wifi, WifiOff } from "lucide-react";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import type { Channel } from "@/lib/types";

/** Get the human-readable slug from a channel name. "#general" → "general" */
function channelSlug(channel: Channel): string {
  return channel.name.replace(/^#/, "");
}

/** Read ?channel= from current URL. */
function readChannelFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("channel");
  } catch {
    return null;
  }
}

/** Write ?channel= to URL without reloading the page.
 * Uses pushState for user-initiated nav (so back button works),
 * replaceState for programmatic syncs (initial load, popstate). */
function writeChannelToUrl(slug: string, push = false): void {
  try {
    const url = new URL(window.location.href);
    // Don't write if already correct
    if (url.searchParams.get("channel") === slug) return;
    url.searchParams.set("channel", slug);
    if (push) {
      window.history.pushState(null, "", url.toString());
    } else {
      window.history.replaceState(null, "", url.toString());
    }
  } catch {
    // URL API unavailable (test env)
  }
}

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
  const [searchOpen, setSearchOpen] = useState(false);

  // Keyboard shortcuts
  const shortcutHandlers = useMemo(() => ({
    onToggleSearch: () => setSearchOpen((v) => !v),
    onToggleFeatures: () => setFeaturesOpen((v) => !v),
  }), []);
  useKeyboardShortcuts(shortcutHandlers);
  const initialUrlApplied = useRef(false);
  const isUserNavigation = useRef(false);

  // Connect WebSocket and subscribe to all channels
  const { subscribe } = useWebSocket(true);

  // Resolve a channel slug from the URL to a channel ID
  const resolveSlugToId = useCallback(
    (slug: string): string | null => {
      if (!channels?.length) return null;
      // Try exact match: #slug
      const match = channels.find((c) => channelSlug(c) === slug);
      return match?.id ?? null;
    },
    [channels],
  );

  // On initial mount + channels load: read ?channel= from URL and navigate
  useEffect(() => {
    if (initialUrlApplied.current || !channels?.length) return;
    initialUrlApplied.current = true;

    const slug = readChannelFromUrl();
    if (slug) {
      const id = resolveSlugToId(slug);
      if (id) {
        setActiveChannelId(id);
        return;
      }
    }
    // No valid URL param — fall back to #general or first channel
    const general = channels.find((c) => c.name === "#general");
    setActiveChannelId(general?.id ?? channels[0].id);
  }, [channels, resolveSlugToId, setActiveChannelId]);

  // User-initiated channel selection — pushes browser history
  const selectChannel = useCallback(
    (id: string | null) => {
      isUserNavigation.current = true;
      setActiveChannelId(id);
    },
    [setActiveChannelId],
  );

  // Sync URL when activeChannelId changes
  useEffect(() => {
    if (!activeChannelId || !channels?.length) return;
    const channel = channels.find((c) => c.id === activeChannelId);
    if (channel) {
      writeChannelToUrl(channelSlug(channel), isUserNavigation.current);
      isUserNavigation.current = false;
    }
  }, [activeChannelId, channels]);

  // Listen for browser back/forward navigation (popstate)
  useEffect(() => {
    const handlePopState = () => {
      const slug = readChannelFromUrl();
      if (slug && channels?.length) {
        const id = resolveSlugToId(slug);
        if (id && id !== useAppStore.getState().activeChannelId) {
          setActiveChannelId(id);
        }
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [channels, resolveSlugToId, setActiveChannelId]);

  // Subscribe to all channel IDs via WebSocket
  useEffect(() => {
    if (channels?.length) {
      subscribe(channels.map((c) => c.id));
    }
  }, [channels, subscribe]);

  const activeChannel = channels?.find((c) => c.id === activeChannelId);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-[2px] md:hidden"
          onClick={() => useAppStore.getState().toggleSidebar()}
        />
      )}

      {/* Left sidebar */}
      <aside
        className={`flex h-full flex-col border-r border-border/50 bg-sidebar transition-all duration-200 ${
          sidebarOpen
            ? "fixed inset-y-0 left-0 z-40 w-64 shadow-xl md:relative md:shadow-none"
            : "w-0 overflow-hidden"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <img
            src="/favicon-96x96.png"
            alt="TalkTo"
            className="h-7 w-7 rounded-md"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-sidebar-foreground">
              TalkTo
            </h2>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center">
                {wsConnected ? (
                  <Wifi className="h-3.5 w-3.5 text-talkto-online" />
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
              onSelectChannel={selectChannel}
              isLoading={channelsLoading}
            />

            <div className="px-3 py-3">
              <Separator className="opacity-30" />
            </div>

            <AgentList agents={agents ?? []} isLoading={agentsLoading} onSelectChannel={selectChannel} />
          </div>
        </ScrollArea>
      </aside>

      {/* Center: main content */}
      <main className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          channel={activeChannel ?? null}
          onToggleFeatures={() => setFeaturesOpen(!featuresOpen)}
          featuresOpen={featuresOpen}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen(!searchOpen)}
        />
        <div className="flex-1 overflow-hidden">{children}</div>
      </main>

      {/* Right panel: features (Sheet overlay) */}
      <FeaturePanel open={featuresOpen} onOpenChange={setFeaturesOpen} />
    </div>
  );
}
