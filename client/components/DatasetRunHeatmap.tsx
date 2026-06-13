"use client";

/**
 * Batch run heatmap (Demo feature #5).
 *
 * Renders a per-row × per-dimension grid of colored score chips for a
 * DatasetRun, with a big "X / Y passing" tile and a thin progress bar. While
 * the run is `pending` or `running` we poll the server every 1s; we stop on
 * any terminal status (`completed`, `failed`, `cancelled`). Newly-completed
 * cells fade in via a CSS transition.
 *
 * Thresholds come from `client/lib/thresholds.ts` — the same source of truth
 * used by the animated tiles in EvaluationResultPanel.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { datasetsApi, type DatasetRunHeatmap, type DatasetRunHeatmapRow } from "@/lib/api";
import { cn } from "@/lib/cn";
import { DIMENSION_THRESHOLDS, type DimensionKey } from "@/lib/thresholds";

const DIMENSIONS: DimensionKey[] = [
  "similarity",
  "accuracy",
  "completeness",
  "relevance",
  "readability",
];

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function cellClasses(value: number | null | undefined, threshold: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "bg-surface-sunken text-text-muted";
  }
  if (value >= threshold) return "bg-success-soft text-text";
  if (value >= 60) return "bg-warn-soft text-text";
  return "bg-danger-soft text-text";
}

function truncate(s: string, max = 40): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

interface PassTileProps {
  passing: number;
  total: number;
}

function PassTile({ passing, total }: PassTileProps) {
  // Animated count-up via setState transition. We tween the displayed
  // `passing` count toward the real value over ~400ms whenever it changes.
  const [shown, setShown] = React.useState(passing);
  const targetRef = React.useRef(passing);
  React.useEffect(() => {
    targetRef.current = passing;
    const start = shown;
    const end = passing;
    if (start === end) return;
    const duration = 400;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = Math.round(start + (end - start) * t);
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // We only want this to fire when `passing` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passing]);

  const tone =
    total > 0 && shown / total >= 0.8
      ? "text-success"
      : total > 0 && shown / total >= 0.6
        ? "text-warn"
        : "text-danger";

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4 min-w-[180px]">
      <div className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
        Passing
      </div>
      <div
        className={cn(
          "mt-1 font-serif text-[32px] leading-9 tabular-nums",
          tone,
        )}
      >
        {shown} <span className="text-text-muted">/ {total}</span>
      </div>
      <div className="font-sans text-[11px] text-text-muted mt-1">
        combined ≥ {DIMENSION_THRESHOLDS.combined}
      </div>
    </div>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 rounded-full bg-surface-sunken overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="font-mono tabular-nums text-[12px] text-text-muted">
        {completed}/{total}
      </div>
    </div>
  );
}

function DimCell({
  value,
  threshold,
  status,
}: {
  value: number | null | undefined;
  threshold: number;
  status: DatasetRunHeatmapRow["status"];
}) {
  if (status === "pending") {
    return (
      <td className="px-1.5 py-1">
        <div className="flex h-7 items-center justify-center rounded-md bg-surface-sunken">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
        </div>
      </td>
    );
  }
  if (status === "error" || value === null || value === undefined) {
    return (
      <td className="px-1.5 py-1">
        <div className="flex h-7 items-center justify-center rounded-md bg-surface-sunken font-mono text-[12px] text-text-muted">
          —
        </div>
      </td>
    );
  }
  return (
    <td className="px-1.5 py-1">
      <div
        className={cn(
          "flex h-7 items-center justify-center rounded-md font-mono text-[12px] tabular-nums transition-opacity duration-300 opacity-100",
          cellClasses(value, threshold),
        )}
      >
        {value.toFixed(0)}
      </div>
    </td>
  );
}

export function DatasetRunHeatmap({ runId }: { runId: string }) {
  const q = useQuery<DatasetRunHeatmap>({
    queryKey: ["dataset-run-heatmap", runId],
    queryFn: () => datasetsApi.getRunHeatmap(runId),
    // Poll every 1s while the run is in-flight; stop on terminal states.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1000;
      return TERMINAL_STATUSES.has(data.status) ? false : 1000;
    },
    refetchIntervalInBackground: false,
  });

  if (q.isLoading || !q.data) {
    return (
      <div className="flex items-center gap-2 font-sans text-[13px] text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading heatmap…
      </div>
    );
  }

  const data = q.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <PassTile passing={data.passing_rows} total={data.total_rows} />
        <div className="flex flex-1 flex-col justify-center gap-2 rounded-xl border border-border bg-surface-raised p-4">
          <div className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
            Progress · {data.status}
          </div>
          <ProgressBar completed={data.completed_rows} total={data.total_rows} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface-raised">
        <div className="max-h-[480px] overflow-y-auto">
          <table className="min-w-full font-sans text-[13px]">
            <thead className="sticky top-0 bg-surface-raised">
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Question
                </th>
                {DIMENSIONS.map((d) => (
                  <th
                    key={d}
                    className="px-1.5 py-2 text-center text-[11px] uppercase tracking-[0.04em] text-text-muted"
                    title={`pass ≥ ${DIMENSION_THRESHOLDS[d]}`}
                  >
                    {d.slice(0, 4)}
                  </th>
                ))}
                <th className="px-1.5 py-2 text-center text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Comb
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                if (row.status === "error") {
                  return (
                    <tr
                      key={row.row_id}
                      className="border-t border-border bg-danger-soft/60"
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="text-text">
                          {truncate(row.question)}
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-danger">
                          {row.error ?? "error"}
                        </div>
                      </td>
                      <td
                        colSpan={DIMENSIONS.length + 1}
                        className="px-1.5 py-2 text-center font-mono text-[12px] text-danger"
                      >
                        failed
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={row.row_id} className="border-t border-border">
                    <td className="px-3 py-2 align-middle">
                      <div className="text-text">{truncate(row.question)}</div>
                    </td>
                    {DIMENSIONS.map((d) => (
                      <DimCell
                        key={d}
                        value={row.dimensions?.[d]}
                        threshold={DIMENSION_THRESHOLDS[d]}
                        status={row.status}
                      />
                    ))}
                    <DimCell
                      value={row.combined_score}
                      threshold={DIMENSION_THRESHOLDS.combined}
                      status={row.status}
                    />
                  </tr>
                );
              })}
              {data.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={DIMENSIONS.length + 2}
                    className="px-3 py-6 text-center font-sans text-[13px] text-text-muted"
                  >
                    No rows in this run.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
