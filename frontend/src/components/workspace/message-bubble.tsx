/** Individual message bubble — lazy-loads markdown renderer for rich content. */
import type { Message } from "@/lib/types";
import { Bot, User, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPlainText, formatTime } from "@/lib/message-utils";
import { highlightMentions } from "@/lib/highlight-mentions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(
  () => import("@/components/workspace/markdown-renderer"),
);

interface MessageBubbleProps {
  message: Message;
  isOwnMessage: boolean;
  showSender: boolean;
  onDelete?: (messageId: string) => void;
}

export function MessageBubble({
  message,
  isOwnMessage: _isOwnMessage, // eslint-disable-line @typescript-eslint/no-unused-vars
  showSender,
  onDelete,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent";
  const time = formatTime(message.created_at);

  return (
    <div
      className={cn(
        "group relative rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40",
        showSender ? "mt-3 pt-2" : "mt-px",
        isAgent && "hover:bg-talkto-agent-subtle/50",
      )}
    >
      {/* Delete button — appears on hover */}
      {onDelete && (
        <button
          onClick={() => onDelete(message.id)}
          className="absolute right-2 top-1 z-10 rounded p-1 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-destructive hover:bg-destructive/10"
          title="Delete message"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Sender line */}
      {showSender && (
        <div className="mb-1 flex items-center gap-2">
          {/* Avatar — square for agents, circle for humans */}
          <Avatar shape={isAgent ? "square" : "circle"}>
            <AvatarFallback
              className={cn(
                isAgent
                  ? "bg-talkto-agent/12 text-talkto-agent"
                  : "bg-primary/8 text-primary",
              )}
            >
              {isAgent ? (
                <Bot className="h-4 w-4" />
              ) : (
                <User className="h-4 w-4" />
              )}
            </AvatarFallback>
          </Avatar>

          <span
            className={cn(
              "text-[13px] font-semibold truncate max-w-[200px]",
              isAgent ? "text-talkto-agent-foreground" : "text-foreground",
            )}
          >
            {message.sender_name ?? "Unknown"}
          </span>

          {/* Agent badge */}
          {isAgent && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-talkto-agent/10 text-talkto-agent">
              Agent
            </span>
          )}

          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {time}
          </span>
        </div>
      )}

      {/* Message content */}
      <div className="pl-10 text-[13.5px] leading-relaxed">
        <MessageContent
          content={message.content}
          mentions={message.mentions}
        />
      </div>

      {/* Hover timestamp (when sender line is hidden) */}
      {!showSender && (
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/40">
          {time}
        </span>
      )}
    </div>
  );
}

// ─── Message content: plain or markdown ─────────────────────────────────────

function MessageContent({
  content,
  mentions,
}: {
  content: string;
  mentions: string[] | null;
}) {
  // Fast path: simple text messages skip the markdown parser entirely
  if (isPlainText(content) && !mentions?.length) {
    return <span className="text-foreground/90">{content}</span>;
  }

  if (isPlainText(content) && mentions?.length) {
    return (
      <span className="text-foreground/90">
        {highlightMentions(content, mentions)}
      </span>
    );
  }

  // Rich content: lazy-load the full markdown renderer
  return (
    <Suspense
      fallback={
        <span className="text-foreground/90">{content.slice(0, 200)}</span>
      }
    >
      <MarkdownRenderer content={content} mentions={mentions} />
    </Suspense>
  );
}
