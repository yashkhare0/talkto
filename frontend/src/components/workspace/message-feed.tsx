/** Message feed — displays messages for the active channel. */
import { useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { useMessages, useMe, useDeleteMessage, usePinMessage, useEditMessage } from "@/hooks/use-queries";
import { useAppStore } from "@/stores/app-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./message-bubble";
import { MessageInput } from "./message-input";
import { AlertTriangle, Bot, MessageSquare } from "lucide-react";
import { formatDateSeparator, shouldShowDateSeparator } from "@/lib/message-utils";
import type { Message } from "@/lib/types";

const MarkdownRenderer = lazy(
  () => import("@/components/workspace/markdown-renderer"),
);

export function MessageFeed() {
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const realtimeMessages = useAppStore((s) => s.realtimeMessages);
  const typingAgents = useAppStore((s) => s.typingAgents);
  const streamingMessages = useAppStore((s) => s.streamingMessages);
  const invocationError = useAppStore((s) => s.invocationError);
  const clearInvocationError = useAppStore((s) => s.clearInvocationError);
  const setReplyToMessage = useAppStore((s) => s.setReplyToMessage);
  const { data: fetchedMessages, isLoading } = useMessages(activeChannelId);
  const { data: me } = useMe();
  const deleteMessage = useDeleteMessage();
  const pinMessage = usePinMessage();
  const editMessage = useEditMessage();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Get typing agents for current channel
  const currentTyping = activeChannelId
    ? Array.from(typingAgents.get(activeChannelId) ?? [])
    : [];

  // Get streaming text for typing agents in current channel
  const channelStreams = activeChannelId
    ? streamingMessages.get(activeChannelId)
    : undefined;

  // Split typing agents into those with streaming text vs those still waiting
  const streamingAgents = currentTyping.filter(
    (name) => channelStreams?.has(name) && (channelStreams.get(name) ?? "").length > 0
  );
  const waitingAgents = currentTyping.filter(
    (name) => !streamingAgents.includes(name)
  );

  // Show invocation error for current channel, auto-clear after 5s
  const currentError =
    invocationError?.channelId === activeChannelId ? invocationError.message : null;

  useEffect(() => {
    if (!currentError) return;
    const timer = setTimeout(clearInvocationError, 5000);
    return () => clearTimeout(timer);
  }, [currentError, clearInvocationError]);

  // Merge fetched + real-time messages, deduplicate by ID, sort chronologically
  const messages = useMemo(() => {
    const fetched = fetchedMessages ?? [];
    const realtime = realtimeMessages.filter(
      (m) => m.channel_id === activeChannelId,
    );

    const byId = new Map<string, Message>();
    // Fetched messages come in reverse chronological — reverse them
    for (const msg of [...fetched].reverse()) {
      byId.set(msg.id, msg);
    }
    // Real-time messages override fetched
    for (const msg of realtime) {
      byId.set(msg.id, msg);
    }

    return Array.from(byId.values()).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    );
  }, [fetchedMessages, realtimeMessages, activeChannelId]);

  // Edit handler
  const handleEdit = useCallback(
    (messageId: string, content: string) => {
      if (!activeChannelId) return;
      editMessage.mutate({ channelId: activeChannelId, messageId, content });
    },
    [activeChannelId, editMessage],
  );

  // Delete handler
  const handleDelete = useCallback(
    (messageId: string) => {
      if (!activeChannelId) return;
      deleteMessage.mutate({ channelId: activeChannelId, messageId });
    },
    [activeChannelId, deleteMessage],
  );

  // Pin handler
  const handlePin = useCallback(
    (messageId: string) => {
      if (!activeChannelId) return;
      pinMessage.mutate({ channelId: activeChannelId, messageId });
    },
    [activeChannelId, pinMessage],
  );

  // Reply handler
  const handleReply = useCallback(
    (message: Message) => {
      setReplyToMessage(message);
    },
    [setReplyToMessage],
  );

  // Build a map of message IDs to messages for parent lookups
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const msg of messages) {
      map.set(msg.id, msg);
    }
    return map;
  }, [messages]);

  // Track whether user is near the bottom of the scroll area.
  // Only auto-scroll if they haven't scrolled up to read history.
  const isNearBottom = useRef(true);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    const viewport = scrollAreaRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    if (!viewport) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    // "Near bottom" = within 150px of the bottom edge
    isNearBottom.current = scrollHeight - scrollTop - clientHeight < 150;
  }, []);

  // Attach scroll listener to the radix viewport
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    if (!viewport) return;
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Auto-scroll to bottom on new messages or streaming updates — only if near bottom
  const streamingText = streamingAgents.map(
    (name) => channelStreams?.get(name) ?? ""
  ).join("");
  useEffect(() => {
    if (isNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, streamingText.length, currentTyping.length]);

  if (!activeChannelId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground/50">
          <MessageSquare className="mx-auto mb-3 h-10 w-10" />
          <p className="text-sm">Select a channel to start</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages area */}
      <ScrollArea ref={scrollAreaRef} className="flex-1 overflow-hidden">
        <div className="px-4 py-4 space-y-0.5">
          {isLoading && <MessageSkeleton />}

          {!isLoading && messages.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <p className="text-sm text-muted-foreground/60">
                  No messages yet
                </p>
                <p className="mt-1 text-xs text-muted-foreground/30">
                  Send a message to get started
                </p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const prevMsg = messages[i - 1];
            const showDate = shouldShowDateSeparator(
              prevMsg?.created_at,
              msg.created_at,
            );
            const showSender =
              showDate || !prevMsg || prevMsg.sender_id !== msg.sender_id;

            return (
              <div key={msg.id}>
                {showDate && <DateSeparator iso={msg.created_at} />}
                <MessageBubble
                  message={msg}
                  parentMessage={msg.parent_id ? messagesById.get(msg.parent_id) ?? null : null}
                  isOwnMessage={msg.sender_id === me?.id}
                  showSender={showSender}
                  onDelete={handleDelete}
                  onPin={handlePin}
                  onEdit={handleEdit}
                  onReply={handleReply}
                />
              </div>
            );
          })}

          {/* Streaming ghost messages — inline with the message flow */}
          {streamingAgents.map((agentName) => (
            <StreamingMessage
              key={`streaming-${agentName}`}
              agentName={agentName}
              text={channelStreams?.get(agentName) ?? ""}
            />
          ))}

          {/* Typing indicator for agents that haven't started streaming yet */}
          {waitingAgents.length > 0 && (
            <TypingIndicator agents={waitingAgents} />
          )}

          {/* Invocation error */}
          {currentError && !currentTyping.length && (
            <InvocationError message={currentError} />
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <MessageInput channelId={activeChannelId} />
    </div>
  );
}

/** Horizontal rule with a date label centered — Slack-style day divider. */
function DateSeparator({ iso }: { iso: string }) {
  return (
    <div className="relative flex items-center py-3">
      <div className="flex-1 border-t border-border" />
      <span className="mx-3 shrink-0 text-[11px] font-medium text-muted-foreground">
        {formatDateSeparator(iso)}
      </span>
      <div className="flex-1 border-t border-border" />
    </div>
  );
}

/** Inline error shown when an agent invocation fails. */
function InvocationError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <AlertTriangle className="h-3.5 w-3.5 text-talkto-warning" />
      <span className="text-xs text-talkto-warning/80">{message}</span>
    </div>
  );
}

/** Ghost message shown while an agent is streaming its response in real-time. */
function StreamingMessage({ agentName, text }: { agentName: string; text: string }) {
  return (
    <div className="group relative px-2 py-1 rounded-md mt-3 pt-2">
      {/* Sender line — matches MessageBubble layout */}
      <div className="mb-1 flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-talkto-agent/12">
          <Bot className="h-4 w-4 text-talkto-agent" />
        </div>
        <span className="text-[13px] font-semibold truncate max-w-[200px] text-talkto-agent-foreground">
          {agentName}
        </span>
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-talkto-agent/10 text-talkto-agent">
          Agent
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
          streaming
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-talkto-agent/40" />
        </span>
      </div>
      {/* Streaming content — rendered as markdown for consistency */}
      <div className="pl-10 text-[13.5px] leading-relaxed">
        <Suspense fallback={<span className="text-foreground/70">{text.slice(0, 200)}</span>}>
          <MarkdownRenderer content={text} mentions={null} />
        </Suspense>
        <span className="inline-block h-3.5 w-0.5 animate-pulse bg-talkto-agent/50 align-text-bottom rounded-full" />
      </div>
    </div>
  );
}

/** Typing indicator shown when an agent is processing an invocation. */
function TypingIndicator({ agents }: { agents: string[] }) {
  const label =
    agents.length === 1
      ? `${agents[0]} is thinking`
      : `${agents.slice(0, -1).join(", ")} and ${agents[agents.length - 1]} are thinking`;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <Bot className="h-3.5 w-3.5 text-muted-foreground/50" />
      <span className="text-xs text-muted-foreground/60">
        {label}
      </span>
      <span className="inline-flex gap-0.5">
        <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:0ms]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:300ms]" />
      </span>
    </div>
  );
}

/** Skeleton placeholder for loading messages. */
function MessageSkeleton() {
  return (
    <div className="space-y-4 py-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-start gap-2 px-2">
          <Skeleton className="h-6 w-6 rounded-md shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-2.5 w-10 rounded" />
            </div>
            <Skeleton className="h-3 w-full rounded" />
            {i % 2 === 0 && <Skeleton className="h-3 w-3/4 rounded" />}
          </div>
        </div>
      ))}
    </div>
  );
}
