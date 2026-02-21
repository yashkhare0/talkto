/** Top header bar showing current channel info and controls. */
import { useState, useCallback } from "react";
import type { Channel } from "@/lib/types";
import { useAppStore } from "@/stores/app-store";
import { useMe, useAgents } from "@/hooks/use-queries";
import {
  Hash,
  FolderGit2,
  PanelLeftClose,
  PanelLeft,
  Lightbulb,
  Settings,
  Bot,
  Moon,
  Sun,
  Search,
  X,
  Loader2,
} from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarBadge } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProfilePanel } from "./profile-panel";

interface WorkspaceHeaderProps {
  channel: Channel | null;
  onToggleFeatures?: () => void;
  featuresOpen?: boolean;
}

export function WorkspaceHeader({
  channel,
  onToggleFeatures,
  featuresOpen,
}: WorkspaceHeaderProps) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const darkMode = useAppStore((s) => s.darkMode);
  const toggleDarkMode = useAppStore((s) => s.toggleDarkMode);
  const agentStatuses = useAppStore((s) => s.agentStatuses);
  const { data: me } = useMe();
  const { data: agents } = useAgents();
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<api.SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const handleSearch = useCallback(async (q: string) => {
    setSearchQuery(q);
    if (q.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const data = await api.searchMessages(q.trim());
      setSearchResults(data.results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // DM channel detection: #dm-{agent_name}
  const isDM = channel?.type === "dm";
  const dmAgentName = isDM ? channel.name.replace(/^#dm-/, "") : null;
  const dmAgent = dmAgentName
    ? agents?.find((a) => a.agent_name === dmAgentName)
    : null;
  const dmAgentStatus = dmAgentName
    ? agentStatuses.get(dmAgentName) ?? dmAgent?.status ?? "offline"
    : null;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/50 px-4">
        {/* Sidebar toggle */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={toggleSidebar}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="h-4 w-4" />
          ) : (
            <PanelLeft className="h-4 w-4" />
          )}
        </Button>

        {/* Channel info */}
        {channel ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isDM ? (
              <>
                <Avatar size="sm" shape="square">
                  <AvatarFallback
                    className={cn(
                      dmAgentStatus === "online"
                        ? "bg-talkto-agent/12 text-talkto-agent"
                        : "bg-muted text-muted-foreground/40",
                    )}
                  >
                    <Bot className="h-3.5 w-3.5" />
                  </AvatarFallback>
                  <AvatarBadge
                    className={cn(
                      dmAgentStatus === "online"
                        ? "bg-talkto-online"
                        : "bg-muted-foreground/30",
                    )}
                  />
                </Avatar>
                <h1 className="truncate text-sm font-semibold">
                  {dmAgentName}
                </h1>
                {dmAgent?.current_task && (
                  <Badge variant="outline" className="hidden sm:inline-flex h-5 max-w-[250px] truncate text-[10px] font-normal text-muted-foreground/60">
                    {dmAgent.current_task}
                  </Badge>
                )}
              </>
            ) : (
              <>
                {channel.type === "project" ? (
                  <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <h1 className="truncate text-sm font-semibold">
                  {channel.name.replace(/^#/, "")}
                </h1>
                {channel.type === "project" && channel.project_path && (
                  <Badge variant="outline" className="hidden sm:inline-flex h-5 max-w-[300px] truncate text-[10px] font-mono font-normal text-muted-foreground/50">
                    {channel.project_path}
                  </Badge>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="flex-1">
            <span className="text-sm text-muted-foreground">
              Select a channel
            </span>
          </div>
        )}

        {/* Search button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={searchOpen ? "secondary" : "ghost"}
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) {
                  setSearchQuery("");
                  setSearchResults([]);
                }
              }}
            >
              <Search className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Search messages</p>
          </TooltipContent>
        </Tooltip>

        {/* Right-side actions */}
        {onToggleFeatures && (
          <Button
            variant={featuresOpen ? "secondary" : "ghost"}
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={onToggleFeatures}
          >
            <Lightbulb className="h-4 w-4" />
          </Button>
        )}

        {/* Dark mode toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={toggleDarkMode}
            >
              {darkMode ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{darkMode ? "Switch to light mode" : "Switch to dark mode"}</p>
          </TooltipContent>
        </Tooltip>

        {/* Profile button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setProfileOpen(true)}
            >
              {me ? (
                <Avatar size="sm">
                  <AvatarFallback className="bg-foreground text-background text-[10px] font-semibold">
                    {(me.display_name || me.name).charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <Settings className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{me ? `${me.display_name || me.name} — Profile` : "Profile"}</p>
          </TooltipContent>
        </Tooltip>
      </header>

      {/* Search bar — slides down below header */}
      {searchOpen && (
        <div className="border-b border-border/50 bg-background px-4 py-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search messages..."
              className="w-full rounded-md border border-border/60 bg-muted/20 py-1.5 pl-9 pr-8 text-sm placeholder:text-muted-foreground/40 focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/10"
              autoFocus
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground/50" />
            )}
            {!searching && searchQuery && (
              <button
                onClick={() => { setSearchQuery(""); setSearchResults([]); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border/40 bg-popover">
              {searchResults.map((result) => (
                <div
                  key={result.id}
                  className="border-b border-border/20 px-3 py-2 last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                    <Hash className="h-3 w-3" />
                    <span>{result.channel_name?.replace(/^#/, "")}</span>
                    <span>·</span>
                    <span className="font-medium text-foreground/70">{result.sender_name}</span>
                    <span className="ml-auto">{new Date(result.created_at).toLocaleDateString()}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-foreground/80 line-clamp-2">
                    {result.content}
                  </p>
                </div>
              ))}
            </div>
          )}

          {searchQuery.length >= 2 && !searching && searchResults.length === 0 && (
            <p className="mt-2 text-center text-xs text-muted-foreground/50">No results found</p>
          )}
        </div>
      )}

      {/* Profile sheet */}
      <ProfilePanel open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  );
}
