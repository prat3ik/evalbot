"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

interface MarkdownProps {
  source: string;
  className?: string;
}

// Tailwind-styled element overrides so the renderer matches the rest of the
// app's typography without dragging in `@tailwindcss/typography`. All blocks
// are sized for an in-card preview, not for a long-form article surface.
const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 font-serif text-[18px] font-semibold leading-7 text-text first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 font-serif text-[16px] font-semibold leading-6 text-text">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-3 font-serif text-[14px] font-semibold leading-5 text-text">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 font-sans text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mb-2 font-sans text-[13px] leading-[20px] text-text">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 ml-5 list-disc space-y-1 font-sans text-[13px] leading-[20px] text-text marker:text-text-subtle">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 ml-5 list-decimal space-y-1 font-sans text-[13px] leading-[20px] text-text marker:text-text-subtle">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-border pl-3 font-sans text-[13px] italic leading-[20px] text-text-muted">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent-pressed underline decoration-text-subtle underline-offset-2 hover:decoration-accent-pressed"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-t border-border" />,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children, ...props }) => {
    const isInline = !className?.startsWith("language-");
    if (isInline) {
      return (
        <code
          className="rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-[12px] text-text"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(className, "block font-mono text-[12px] leading-5 text-text")}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    // Pull the language tag off the inner <code> so we can show it as a label.
    let lang = "";
    if (
      React.isValidElement(children) &&
      typeof (children.props as { className?: string }).className === "string"
    ) {
      const cls = (children.props as { className: string }).className;
      const m = /language-(\S+)/.exec(cls);
      if (m) lang = m[1];
    }
    return (
      <div className="mb-3 overflow-hidden rounded-md border border-border bg-surface-sunken">
        {lang && (
          <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-1 font-sans text-[11px] uppercase tracking-[0.04em] text-text-subtle">
            <span>{lang}</span>
          </div>
        )}
        <pre className="max-h-[260px] overflow-auto px-3 py-2 font-mono text-[12px] leading-5 text-text">
          {children}
        </pre>
      </div>
    );
  },
  table: ({ children }) => (
    <div className="mb-3 overflow-auto">
      <table className="w-full border-collapse font-sans text-[12px] text-text">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-sunken">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-medium text-text">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1 align-top text-text-muted">{children}</td>
  ),
};

export function Markdown({ source, className }: MarkdownProps) {
  return (
    <div className={cn("font-sans text-[13px] leading-[20px] text-text", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
