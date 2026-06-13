import * as React from "react";

export interface HighlightSpan {
  start: number;
  end: number;
  /** Free-form kind tag that gets passed through to the renderer (e.g. "email"). */
  kind?: string;
}

/**
 * Slice ``text`` along the given spans and emit a flat array of plain strings
 * and `<mark>` React elements. Spans are sorted and clipped to the text bounds;
 * overlapping spans collapse to the earlier one to avoid nested marks.
 */
export function renderHighlighted(
  text: string,
  spans: HighlightSpan[],
  markClassName = "bg-danger-soft text-danger px-0.5 rounded",
): React.ReactNode[] {
  if (!text) return [];
  if (!spans || spans.length === 0) return [text];

  const sorted = [...spans]
    .filter((s) => s.end > s.start && s.start < text.length)
    .map((s) => ({
      start: Math.max(0, s.start),
      end: Math.min(text.length, s.end),
      kind: s.kind,
    }))
    .sort((a, b) => a.start - b.start);

  // Merge overlaps so we never nest <mark> tags.
  const merged: HighlightSpan[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }

  const out: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach((s, i) => {
    if (cursor < s.start) {
      out.push(text.slice(cursor, s.start));
    }
    out.push(
      React.createElement(
        "mark",
        {
          key: `mark-${i}-${s.start}`,
          className: markClassName,
          "data-kind": s.kind,
        },
        text.slice(s.start, s.end),
      ),
    );
    cursor = s.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
