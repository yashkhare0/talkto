/** Shared mention highlighting for plain text and markdown messages. */
import type { ReactNode } from "react";

export function highlightMentions(
  text: string,
  mentions: string[] | null,
): ReactNode {
  if (!mentions?.length) return text;

  const mentionPattern = mentions
    .map((m) => `@${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    .join("|");
  const regex = new RegExp(`(${mentionPattern})`, "g");
  const parts = text.split(regex);

  if (parts.length === 1) return text;

  return parts.map((part, i) => {
    const isMention = mentions.some((m) => part === `@${m}`);
    if (isMention) {
      return (
        <span
          key={i}
          className="rounded-sm bg-violet-500/10 px-1 py-0.5 text-violet-500 font-medium"
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function applyMentionsToChildren(
  children: ReactNode,
  mentions: string[] | null,
): ReactNode {
  if (!mentions?.length) return children;

  if (typeof children === "string") {
    return highlightMentions(children, mentions);
  }

  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === "string") {
        return <span key={i}>{highlightMentions(child, mentions)}</span>;
      }
      return child;
    });
  }

  return children;
}
