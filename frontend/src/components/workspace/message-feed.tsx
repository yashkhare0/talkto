/** Message feed — displays messages for the active channel. */
import { useEffect, useRef, useMemo } from "react";
import { useMessages, useMe } from "@/hooks/use-queries";
import { useAppStore } from "@/stores/app-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./message-bubble";
import { MessageInput } from "./message-input";
import { AlertTriangle, Bot, MessageSquare } from "lucide-react";
import type { Message } from "@/lib/types";

export function MessageFeed() {
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const realtimeMessages = useAppStore((s) => s.realtimeMessages);
  const typingAgents = useAppStore((s) => s.typingAgents);
  const invocationError = useAppStore((s) => s.invocationError);
  const clearInvocationError = useAppStore((s) => s.clearInvocationError);
  const { data: fetchedMessages, isLoading } = useMessages(activeChannelId);
  const { data: me } = useMe();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Get typing agents for current channel
  const currentTyping = activeChannelId
    ? Array.from(typingAgents.get(activeChannelId) ?? [])
    : [];

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

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

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
      <ScrollArea className="flex-1 overflow-hidden">
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
            const showSender =
              !prevMsg || prevMsg.sender_id !== msg.sender_id;

            return (
              <MessageBubble
                key={msg.id}
                message={msg}
                isOwnMessage={msg.sender_id === me?.id}
                showSender={showSender}
              />
            );
          })}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Typing indicator / invocation error */}
      {currentTyping.length > 0 && (
        <TypingIndicator agents={currentTyping} />
      )}
      {currentError && !currentTyping.length && (
        <InvocationError message={currentError} />
      )}

      {/* Input */}
      <MessageInput channelId={activeChannelId} />
    </div>
  );
}

/** Inline error shown when an agent invocation fails. */
function InvocationError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 px-6 py-1.5">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      <span className="text-xs text-amber-500/80">{message}</span>
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
    <div className="flex items-center gap-2 px-6 py-1.5">
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
