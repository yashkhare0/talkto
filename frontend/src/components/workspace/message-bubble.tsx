/** Individual message bubble — lazy-loads markdown renderer for rich content. */
import type { Message } from "@/lib/types";
import { Bot, User } from "lucide-react";
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
}

export function MessageBubble({
  message,
  isOwnMessage: _isOwnMessage,
  showSender,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent";
  const time = formatTime(message.created_at);

  return (
    <div
      className={cn(
        "group relative px-2 py-1 rounded-md transition-colors hover:bg-muted/30",
        showSender && "mt-3 pt-2",
      )}
    >
      {/* Sender line */}
      {showSender && (
        <div className="mb-1 flex items-center gap-2">
          {/* Avatar */}
          <Avatar>
            <AvatarFallback
              className={cn(
                "rounded-md",
                isAgent
                  ? "bg-violet-500/15 text-violet-500"
                  : "bg-primary/10 text-primary",
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
              "text-sm font-semibold truncate max-w-[200px]",
              isAgent ? "text-violet-500" : "text-foreground",
            )}
          >
            {message.sender_name ?? "Unknown"}
          </span>

          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {time}
          </span>
        </div>
      )}

      {/* Message content */}
      <div
        className="pl-10 text-sm leading-relaxed"
      >
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


