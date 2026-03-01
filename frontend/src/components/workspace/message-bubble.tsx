/** Individual message bubble — lazy-loads markdown renderer for rich content. */
import type { Message } from "@/lib/types";
import { Bot, User, Trash2, Pin, Pencil, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPlainText, formatTime } from "@/lib/message-utils";
import { highlightMentions } from "@/lib/highlight-mentions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { lazy, Suspense, useState, useRef, useEffect } from "react";

const MarkdownRenderer = lazy(
  () => import("@/components/workspace/markdown-renderer"),
);

interface MessageBubbleProps {
  message: Message;
  isOwnMessage: boolean;
  showSender: boolean;
  onDelete?: (messageId: string) => void;
  onPin?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
}

export function MessageBubble({
  message,
  isOwnMessage,
  showSender,
  onDelete,
  onPin,
  onEdit,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent";
  const time = formatTime(message.created_at);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.setSelectionRange(editContent.length, editContent.length);
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveEdit = () => {
    const trimmed = editContent.trim();
    if (trimmed && trimmed !== message.content) {
      onEdit?.(message.id, trimmed);
    }
    setEditing(false);
  };

  const handleCancelEdit = () => {
    setEditContent(message.content);
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "group relative rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40",
        showSender ? "mt-3 pt-2" : "mt-px",
        isAgent && "hover:bg-talkto-agent-subtle/50",
        editing && "bg-primary/5 ring-1 ring-primary/20",
      )}
    >
      {/* Action buttons — appear on hover */}
      {!editing && (
        <div className="absolute right-2 top-1 z-10 flex items-center gap-0.5">
          {onPin && (
            <button
              onClick={() => onPin(message.id)}
              className={cn(
                "rounded p-1 transition-colors",
                message.is_pinned
                  ? "text-talkto-agent/60 hover:text-talkto-agent"
                  : "text-muted-foreground/0 group-hover:text-muted-foreground/50 hover:!text-talkto-agent",
              )}
              title={message.is_pinned ? "Unpin message" : "Pin message"}
            >
              <Pin className="h-3.5 w-3.5" />
            </button>
          )}
          {isOwnMessage && onEdit && (
            <button
              onClick={() => setEditing(true)}
              className="rounded p-1 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-primary"
              title="Edit message"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(message.id)}
              className="rounded p-1 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-destructive hover:bg-destructive/10"
              title="Delete message"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Sender line */}
      {showSender && (
        <div className="mb-1 flex items-center gap-2">
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

          {isAgent && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-talkto-agent/10 text-talkto-agent">
              Agent
            </span>
          )}

          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {time}
          </span>
          {message.is_pinned && (
            <span className="inline-flex items-center gap-0.5 text-[9px] text-talkto-agent/50">
              <Pin className="h-2.5 w-2.5" />
              pinned
            </span>
          )}

          {message.edited_at && (
            <span className="text-[9px] text-muted-foreground/30 italic">
              (edited)
            </span>
          )}
        </div>
      )}

      {/* Message content or edit form */}
      <div className="pl-10 text-[13.5px] leading-relaxed">
        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={editRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveEdit();
                }
                if (e.key === "Escape") handleCancelEdit();
              }}
              className="w-full resize-none rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/10"
              rows={Math.min(editContent.split("\n").length + 1, 8)}
            />
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
              <button
                onClick={handleSaveEdit}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Check className="h-3 w-3" /> Save
              </button>
              <button
                onClick={handleCancelEdit}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-muted transition-colors"
              >
                <X className="h-3 w-3" /> Cancel
              </button>
              <span>escape to cancel · enter to save</span>
            </div>
          </div>
        ) : (
          <MessageContent
            content={message.content}
            mentions={message.mentions}
          />
        )}
      </div>

      {/* Hover timestamp (when sender line is hidden) */}
      {!showSender && (
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/40">
          {time}
          {message.edited_at && (
            <span className="ml-1 italic">(edited)</span>
          )}
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
