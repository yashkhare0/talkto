/** Message input with @-mention autocomplete. */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useSendMessage, useAgents, useMe } from "@/hooks/use-queries";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SendHorizonal, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";

interface MessageInputProps {
  channelId: string;
}

/** Extract the @-mention query being typed at the cursor position. */
function getMentionQuery(text: string, cursorPos: number): { query: string; start: number } | null {
  // Walk backwards from cursor to find the @ trigger
  const before = text.slice(0, cursorPos);
  const match = before.match(/@([\w-]*)$/);
  if (!match) return null;
  return { query: match[1].toLowerCase(), start: cursorPos - match[0].length };
}

export function MessageInput({ channelId }: MessageInputProps) {
  const [content, setContent] = useState("");
  const sendMessage = useSendMessage();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Mention state
  const { data: agents } = useAgents();
  const { data: me } = useMe();
  const agentStatuses = useAppStore((s) => s.agentStatuses);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Build the list of mentionable names
  const mentionables = useMemo(() => {
    const list: { name: string; label: string; type: string; online: boolean }[] = [];

    // Add human user
    if (me) {
      list.push({
        name: me.name,
        label: me.display_name || me.name,
        type: "human",
        online: true,
      });
    }

    // Add all agents (exclude ghosts and system agents)
    if (agents) {
      for (const a of agents) {
        if (a.is_ghost || a.agent_type === "system") continue;
        list.push({
          name: a.agent_name,
          label: a.agent_name,
          type: a.agent_type,
          online: (agentStatuses.get(a.agent_name) ?? a.status) === "online",
        });
      }
    }

    return list;
  }, [agents, me, agentStatuses]);

  // Filter mentionables by the current query
  const filtered = useMemo(() => {
    if (!mentionQuery) return mentionables;
    return mentionables.filter((m) => m.name.toLowerCase().includes(mentionQuery));
  }, [mentionables, mentionQuery]);

  // Reset selection when filtered list changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [filtered.length, mentionQuery]);

  // Track cursor and detect @-mention trigger
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setContent(val);

      const cursor = e.target.selectionStart ?? val.length;
      const mention = getMentionQuery(val, cursor);

      if (mention) {
        setMentionOpen(true);
        setMentionQuery(mention.query);
        setMentionStart(mention.start);
      } else {
        setMentionOpen(false);
      }
    },
    [],
  );

  // Insert a mention into the content
  const insertMention = useCallback(
    (name: string) => {
      const before = content.slice(0, mentionStart);
      const after = content.slice(
        mentionStart + 1 + mentionQuery.length, // +1 for the @
      );
      const newContent = `${before}@${name} ${after}`;
      setContent(newContent);
      setMentionOpen(false);

      // Refocus and set cursor after the inserted mention
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = before.length + name.length + 2; // @ + name + space
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    },
    [content, mentionStart, mentionQuery],
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed) return;

    // Extract @mentions from content
    const mentionRegex = /@([\w-]+)/g;
    const mentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(trimmed)) !== null) {
      mentions.push(match[1]);
    }

    try {
      await sendMessage.mutateAsync({
        channelId,
        content: trimmed,
        mentions: mentions.length > 0 ? mentions : undefined,
      });
      setContent("");
      setMentionOpen(false);
      textareaRef.current?.focus();
    } catch {
      // Error state available via sendMessage.isError
    }
  }, [content, channelId, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionOpen && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(filtered[selectedIdx].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    if (!mentionOpen || !menuRef.current) return;
    const item = menuRef.current.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, mentionOpen]);

  return (
    <div className="shrink-0 border-t border-border/50 p-4">
      <div className="relative flex items-end gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 focus-within:border-foreground/20 focus-within:ring-1 focus-within:ring-foreground/10">
        {/* @-mention dropdown */}
        {mentionOpen && filtered.length > 0 && (
          <div
            ref={menuRef}
            className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
          >
            {filtered.map((m, i) => (
              <button
                key={m.name}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                  i === selectedIdx
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent textarea blur
                  insertMention(m.name);
                }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <Avatar className="h-5 w-5 text-[10px]">
                  <AvatarFallback
                    className={cn(
                      "text-[10px]",
                      m.type === "human"
                        ? "bg-amber-500/15 text-amber-600"
                        : "bg-violet-500/15 text-violet-500",
                    )}
                  >
                    {m.name[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate font-medium">{m.label}</span>
                <span
                  className={cn(
                    "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
                    m.online ? "bg-emerald-500" : "bg-muted-foreground/30",
                  )}
                />
                <span className="text-[11px] text-muted-foreground">{m.type}</span>
              </button>
            ))}
          </div>
        )}

        <Textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message this channel... (@ to mention)"
          className="min-h-[36px] max-h-[120px] resize-none border-0 bg-transparent p-0 text-sm shadow-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
          rows={1}
          disabled={sendMessage.isPending}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
          onClick={handleSubmit}
          disabled={!content.trim() || sendMessage.isPending}
        >
          {sendMessage.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SendHorizonal className="h-4 w-4" />
          )}
        </Button>
      </div>

      {sendMessage.isError && (
        <p className="mt-1 text-xs text-destructive">
          Failed to send. Retry?
        </p>
      )}
    </div>
  );
}
