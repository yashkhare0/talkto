/**
 * Markdown renderer for chat messages.
 *
 * Lazy-loaded by message-bubble.tsx to keep the initial bundle small.
 * Supports GFM (tables, strikethrough, task lists, autolinks),
 * syntax-highlighted code blocks with copy button, inline images,
 * and @mention highlighting.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useMemo, useState, useCallback, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { applyMentionsToChildren } from "@/lib/highlight-mentions";

interface MarkdownRendererProps {
  content: string;
  mentions: string[] | null;
}

// ─── Copy button for code blocks ────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      className={cn(
        "absolute right-2 top-2 h-7 w-7 transition-all",
        "bg-muted-foreground/10 hover:bg-muted-foreground/20",
        "opacity-0 group-hover/code:opacity-100",
        copied && "opacity-100",
      )}
      aria-label="Copy code"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </Button>
  );
}

/** Extract plain text from React children (for the copy button). */
function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

// ─── Image URL detection ────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)(\?.*)?$/i;

function isImageUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    return IMAGE_EXTENSIONS.test(url.pathname);
  } catch {
    return IMAGE_EXTENSIONS.test(href);
  }
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function MarkdownRenderer({
  content,
  mentions,
}: MarkdownRendererProps) {
  const components = useMemo<Components>(() => {
    return {
      // Text containers — apply mention highlighting
      p: ({ children }) => (
        <p className="mb-1 last:mb-0">
          {applyMentionsToChildren(children, mentions)}
        </p>
      ),
      li: ({ children, className }) => {
        // GFM task list items get a special class
        const isTask = className?.includes("task-list-item");
        return (
          <li className={cn(isTask && "flex items-start gap-1.5 list-none -ml-4")}>
            {applyMentionsToChildren(children, mentions)}
          </li>
        );
      },
      td: ({ children }) => (
        <td className="border border-border/40 px-2 py-1">
          {applyMentionsToChildren(children, mentions)}
        </td>
      ),
      th: ({ children }) => (
        <th className="border border-border/40 px-2 py-1 text-left font-semibold bg-muted/40">
          {applyMentionsToChildren(children, mentions)}
        </th>
      ),

      // Headings — compact for chat
      h1: ({ children }) => (
        <p className="mb-1 text-sm font-bold">
          {applyMentionsToChildren(children, mentions)}
        </p>
      ),
      h2: ({ children }) => (
        <p className="mb-1 text-sm font-bold">
          {applyMentionsToChildren(children, mentions)}
        </p>
      ),
      h3: ({ children }) => (
        <p className="mb-1 text-sm font-semibold">
          {applyMentionsToChildren(children, mentions)}
        </p>
      ),

      // Inline styles
      strong: ({ children }) => (
        <strong className="font-semibold">{children}</strong>
      ),
      em: ({ children }) => <em className="italic">{children}</em>,
      del: ({ children }) => (
        <del className="line-through opacity-60">{children}</del>
      ),

      // Links — render images inline if URL points to an image
      a: ({ children, href }) => {
        if (isImageUrl(href)) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" className="block my-1.5">
              <img
                src={href}
                alt={typeof children === "string" ? children : "image"}
                className="max-w-sm max-h-64 rounded-md border border-border/30 object-contain"
                loading="lazy"
              />
            </a>
          );
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 underline underline-offset-2 hover:text-blue-400"
          >
            {children}
          </a>
        );
      },

      // Standalone images
      img: ({ src, alt }) => (
        <img
          src={src}
          alt={alt ?? "image"}
          className="my-1.5 max-w-sm max-h-64 rounded-md border border-border/30 object-contain"
          loading="lazy"
        />
      ),

      // Code — inline
      code: ({ children, className }) => {
        // If it has a language class (hljs), it's inside a pre block — don't add inline styles
        if (className) {
          return (
            <code className={cn("text-[13px] font-mono", className)}>
              {children}
            </code>
          );
        }
        return (
          <code className="rounded-sm bg-muted px-1.5 py-0.5 text-[13px] font-mono text-foreground/80">
            {children}
          </code>
        );
      },

      // Code — block with copy button
      pre: ({ children }) => {
        const text = extractText(children);
        return (
          <div className="group/code relative my-1.5">
            <pre className="overflow-x-auto rounded-md bg-[var(--hljs-bg,var(--muted))] p-3 text-[13px] leading-relaxed">
              {children}
            </pre>
            <CopyButton text={text} />
          </div>
        );
      },

      // Lists
      ul: ({ children, className }) => {
        const isTaskList = className?.includes("contains-task-list");
        return (
          <ul className={cn("my-1 space-y-0.5", isTaskList ? "ml-0" : "ml-4 list-disc")}>
            {children}
          </ul>
        );
      },
      ol: ({ children }) => (
        <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>
      ),

      // GFM task list checkbox
      input: ({ checked, type }) => {
        if (type === "checkbox") {
          return (
            <span
              className={cn(
                "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border mt-0.5",
                checked
                  ? "border-emerald-500 bg-emerald-500/15 text-emerald-500"
                  : "border-muted-foreground/30 bg-transparent",
              )}
              aria-checked={checked ?? false}
              role="checkbox"
            >
              {checked && <Check className="h-3 w-3" />}
            </span>
          );
        }
        return null;
      },

      // Blockquote
      blockquote: ({ children }) => (
        <blockquote className="my-1.5 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground/70 italic">
          {children}
        </blockquote>
      ),

      // Horizontal rule
      hr: () => <Separator className="my-2 opacity-30" />,

      // Table
      table: ({ children }) => (
        <div className="my-1.5 overflow-x-auto rounded-md border border-border/30">
          <table className="w-full text-xs">{children}</table>
        </div>
      ),
    };
  }, [mentions]);

  return (
    <div className="text-foreground/90 [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
