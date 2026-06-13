"use client";

import * as React from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Question } from "@/lib/api";

type PickableQuestion = Question & { id: string };

interface QuestionPickerProps {
  value: string;
  onChange: (id: string) => void;
  questions: PickableQuestion[];
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function QuestionPicker({
  value,
  onChange,
  questions,
  loading,
  disabled,
  placeholder = "Pick a seed question",
}: QuestionPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIdx, setActiveIdx] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selected = React.useMemo(
    () => questions.find((q) => q.id === value) ?? null,
    [questions, value],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return questions;
    return questions.filter(
      (item) =>
        item.text.toLowerCase().includes(q) || (item.category ?? "").toLowerCase().includes(q),
    );
  }, [questions, query]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, PickableQuestion[]>();
    for (const q of filtered) {
      const cat = q.category ?? "Other";
      const arr = map.get(cat) ?? [];
      arr.push(q);
      map.set(cat, arr);
    }
    return Array.from(map.entries());
  }, [filtered]);

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      const t = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  React.useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  const pick = (q: PickableQuestion) => {
    onChange(q.id);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = filtered[activeIdx];
      if (q) pick(q);
    }
  };

  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "h-9 w-full rounded-md border border-border-strong bg-surface-raised px-3",
          "flex items-center gap-2 text-left text-[15px] leading-[22px]",
          "transition-colors hover:bg-surface-sunken",
          "focus-visible:ring-accent/35 focus-visible:outline-none focus-visible:ring-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "ring-accent/35 border-accent ring-2",
        )}
      >
        <span className={cn("flex-1 truncate", !selected && "text-text-subtle")}>
          {loading ? "Loading questions…" : selected ? selected.text : placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1.5 w-full min-w-[28rem]",
            "rounded-lg border border-border bg-surface-raised shadow-elev-3",
            "flex flex-col overflow-hidden",
          )}
          style={{ maxHeight: "min(28rem, 60vh)" }}
        >
          <div className="border-b border-border bg-surface p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search questions…"
                className={cn(
                  "h-9 w-full rounded-md border border-border-strong bg-surface-raised pl-8 pr-8",
                  "text-[14px] leading-[20px]",
                  "focus-visible:ring-accent/35 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2",
                )}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-subtle hover:bg-surface-sunken hover:text-text"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-[14px] text-text-muted">
                No questions match &ldquo;{query}&rdquo;
              </div>
            ) : (
              grouped.map(([cat, items]) => (
                <div key={cat} className="pb-1">
                  <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-muted">
                    {cat}
                  </div>
                  {items.map((q) => {
                    const globalIdx = filtered.indexOf(q);
                    const isActive = globalIdx === activeIdx;
                    const isSelected = q.id === value;
                    return (
                      <button
                        key={q.id}
                        type="button"
                        data-idx={globalIdx}
                        onMouseEnter={() => setActiveIdx(globalIdx)}
                        onClick={() => pick(q)}
                        className={cn(
                          "w-full px-3 py-2 text-left text-[14px] leading-[20px]",
                          "flex items-start gap-2 transition-colors",
                          isActive && "bg-accent-soft",
                          isSelected && !isActive && "bg-surface-sunken",
                        )}
                      >
                        <span
                          className={cn(
                            "flex-1",
                            isSelected ? "font-medium text-accent-pressed" : "text-text",
                          )}
                        >
                          {q.text}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border bg-surface px-3 py-2 text-[11px] leading-[14px] text-text-muted">
            <span>
              {filtered.length} of {questions.length}
            </span>
            <span className="font-mono">↑↓ navigate · ⏎ select · esc close</span>
          </div>
        </div>
      )}
    </div>
  );
}
