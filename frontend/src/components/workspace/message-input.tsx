/** Message input with @-mention autocomplete. */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useSendMessage, useAgents, useMe } from "@/hooks/use-queries";
import { getMentionQuery } from "@/lib/message-utils";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SendHorizonal, Loader2, X, Reply } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";

interface MessageInputProps {
  channelId: string;
}

export function MessageInput({ channelId }: MessageInputProps) {
  const [content, setContent] = useState("");
  const sendMessage = useSendMessage();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replyToMessage = useAppStore((s) => s.replyToMessage);
  const setReplyToMessage = useAppStore((s) => s.setReplyToMessage);

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

    // @all — invoke all agents at once
    list.push({
      name: "all",
      label: "all — notify all agents",
      type: "group",
      online: true,
    });

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

  // Reset selection when filtered list changes.
  // setState in effect is intentional — we need to reset the dropdown index
  // when the filter results change, which is driven by user input.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const handleSubmit = async () => {
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
        parentId: replyToMessage?.id,
      });
      setContent("");
      setMentionOpen(false);
      setReplyToMessage(null);
      textareaRef.current?.focus();
    } catch {
      // Error state available via sendMessage.isError
    }
  };

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
      if (!sendMessage.isPending) {
        handleSubmit();
      }
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
        {/* Reply preview banner */}
        {replyToMessage && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
            <Reply className="h-3.5 w-3.5 text-primary/60 shrink-0" />
            <span className="text-primary/80 font-medium shrink-0">
              {replyToMessage.sender_name}
            </span>
            <span className="truncate text-muted-foreground/70">
              {replyToMessage.content}
            </span>
            <button
              onClick={() => setReplyToMessage(null)}
              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="relative flex items-end gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 transition-[border-color,box-shadow] duration-150 focus-within:border-primary/30 focus-within:ring-1 focus-within:ring-primary/10">
        {/* @-mention dropdown */}
        {mentionOpen && filtered.length > 0 && (
          <div
            ref={menuRef}
            className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in slide-in-from-bottom-2 duration-150"
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
                <Avatar className="h-5 w-5 text-[10px]" shape={m.type !== "human" && m.type !== "group" ? "square" : "circle"}>
                  <AvatarFallback
                    className={cn(
                      "text-[10px]",
                      m.type === "group"
                        ? "bg-primary/12 text-primary"
                        : m.type === "human"
                          ? "bg-primary/8 text-primary"
                          : "bg-talkto-agent/12 text-talkto-agent",
                    )}
                  >
                    {m.type === "group" ? "*" : m.name[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate font-medium">{m.label}</span>
                <span
                  className={cn(
                    "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
                    m.online ? "bg-talkto-online" : "bg-muted-foreground/30",
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
          className="min-h-[44px] max-h-[120px] resize-none border-0 bg-transparent p-0 text-sm shadow-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
          rows={1}
          disabled={sendMessage.isPending}
        />
        <Button
          size="icon-sm"
          variant={content.trim() ? "default" : "ghost"}
          className={cn(
            "shrink-0 transition-colors",
            content.trim()
              ? "text-primary-foreground"
              : "text-muted-foreground hover:text-foreground disabled:opacity-30",
          )}
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
        <button
          type="button"
          onClick={handleSubmit}
          className="mt-1 text-xs text-destructive hover:underline cursor-pointer"
        >
          Failed to send. Retry?
        </button>
      )}
    </div>
  );
}
