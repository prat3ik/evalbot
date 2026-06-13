"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { FileText, MessageSquare } from "lucide-react";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CardTitle } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import {
  api,
  conversationsApi,
  datasetsApi,
  type ConversationListItem,
  type EvaluationSummary,
  type Project,
  type RunNameItem,
  type RunType,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import { scoreBandClasses } from "@/lib/scoreColor";
import {
  groupRuns,
  RunAllDialog,
  RunAllProgressStrip,
  RunGroupCard,
  type RunGroup,
} from "./RunGroupsSection";

type FeedItem =
  | { kind: "eval"; created_at: string; runType: RunType; data: EvaluationSummary }
  | { kind: "chat"; created_at: string; runType: RunType; data: ConversationListItem }
  | { kind: "run_group"; created_at: string; data: RunGroup };

// SCHEDULE_DISABLED — Scheduled filter removed alongside the dataset
// scheduler feature. `RunType` still includes "scheduled" for any legacy
// rows persisted before the removal.
type FilterKey = "all" | "dataset" | "single" | "multi_turn";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "dataset", label: "Dataset runs" },
  { key: "single", label: "Single" },
  { key: "multi_turn", label: "Multi-turn" },
];

export function ActivityTab({ project }: { project: Project }) {
  const projectId = project.id;
  const queryClient = useQueryClient();
  const evaluationsQ = useQuery({
    // Pull a generous slice so single/multi-turn entries don't get crowded
    // out of the latest 50 by large dataset-run batches on cycle days.
    queryKey: ["evaluations", "activity", projectId],
    queryFn: () => api.evaluations.list({ projectId, limit: 500 }),
  });
  const conversationsQ = useQuery({
    queryKey: ["conversations", "activity", projectId],
    queryFn: () => conversationsApi.list(projectId),
  });
  const datasetRunsQ = useQuery({
    queryKey: ["dataset-runs-by-project", projectId],
    queryFn: () => datasetsApi.runsByProject(projectId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const inFlight = data.some(
        (r) => r.status === "pending" || r.status === "running",
      );
      return inFlight ? 2000 : false;
    },
  });

  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [runAllOpen, setRunAllOpen] = React.useState(false);
  const [activeRunIds, setActiveRunIds] = React.useState<string[]>([]);

  // Build set of evaluation_ids that are children of any dataset-run so we
  // can exclude them from the ad-hoc (single / multi-turn) flat feed.
  const datasetEvalIds = React.useMemo(() => {
    const s = new Set<string>();
    (datasetRunsQ.data ?? []).forEach((run) => {
      run.items.forEach((it) => {
        if (it.evaluation_id) s.add(it.evaluation_id);
      });
    });
    return s;
  }, [datasetRunsQ.data]);

  const adHocEvalItems: FeedItem[] = React.useMemo(() => {
    const evs: FeedItem[] = (evaluationsQ.data ?? [])
      .filter((e) => {
        const rt = (e.run_type as RunType) || "single";
        // Exclude dataset-run children — they live inside cascade cards now.
        if (rt === "dataset") return false;
        if (datasetEvalIds.has(e.id)) return false;
        return true;
      })
      .map((e) => ({
        kind: "eval" as const,
        created_at: e.created_at,
        runType: (e.run_type as RunType) || "single",
        data: e,
      }));
    // Skip empty drafts. The Multi-Turn editor creates a placeholder
    // Conversation on tab visit; until the user adds messages it has 0
    // turns and would just clutter the activity feed.
    const chats: FeedItem[] = (conversationsQ.data ?? [])
      .filter((c) => (c.turn_count ?? 0) > 0)
      .map((c) => ({
        kind: "chat" as const,
        created_at: c.created_at,
        runType: "multi_turn" as const,
        data: c,
      }));
    return [...evs, ...chats];
  }, [evaluationsQ.data, conversationsQ.data, datasetEvalIds]);

  const runGroupItems: FeedItem[] = React.useMemo(() => {
    return groupRuns(datasetRunsQ.data ?? []).map((g) => ({
      kind: "run_group" as const,
      created_at: g.startedAt,
      data: g,
    }));
  }, [datasetRunsQ.data]);

  const allItems: FeedItem[] = React.useMemo(() => {
    return [...runGroupItems, ...adHocEvalItems].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [runGroupItems, adHocEvalItems]);

  const visibleItems = React.useMemo(() => {
    if (filter === "all") return allItems;
    if (filter === "dataset") return runGroupItems;
    return adHocEvalItems
      .filter((it) => it.kind !== "run_group" && it.runType === filter)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
  }, [filter, allItems, runGroupItems, adHocEvalItems]);

  const loading =
    evaluationsQ.isLoading || conversationsQ.isLoading || datasetRunsQ.isLoading;

  const openRunResults = React.useCallback(
    (runId: string) => {
      if (typeof window !== "undefined") {
        window.open(`/projects/${projectId}/runs/${runId}`, "_blank");
      }
    },
    [projectId],
  );

  const emptyMessage =
    filter === "dataset"
      ? "No dataset runs yet."
      : filter === "single"
        ? "No single evaluations yet."
        : filter === "multi_turn"
          ? "No multi-turn evaluations yet."
          : "No activity yet";

  return (
    <div className="flex flex-col gap-4">
      {activeRunIds.length > 0 && (
        <RunAllProgressStrip
          runIds={activeRunIds}
          onDismiss={() => setActiveRunIds([])}
        />
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>Activity</CardTitle>
            <p className="mt-1 font-sans text-[13px] leading-[18px] text-text-muted">
              All runs and evaluations for this project, newest first.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={() => setRunAllOpen(true)}>
              Run all datasets
            </Button>
            <CompareRunsButton projectId={projectId} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => {
            const on = f.key === filter;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "h-7 rounded-sm px-2 font-sans text-[12px] transition-colors duration-fast ease-ev",
                  on
                    ? "bg-accent text-accent-fg"
                    : "bg-surface-sunken text-text-muted hover:text-text",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <p className="font-sans text-[14px] text-text-muted">Loading…</p>
        ) : visibleItems.length === 0 ? (
          <div className="py-10 text-center">
            <p className="font-serif text-[18px] leading-[26px] text-text-muted">
              {emptyMessage}
            </p>
            {filter === "dataset" ? (
              <p className="mt-2">
                <Link
                  href={`/projects/${projectId}?tab=datasets`}
                  className="font-sans text-[14px] text-accent-pressed underline hover:text-accent"
                >
                  Go to Datasets →
                </Link>
              </p>
            ) : allItems.length === 0 ? (
              <p className="mt-2">
                <Link
                  href={`/projects/${projectId}?tab=evaluate`}
                  className="font-sans text-[14px] text-accent-pressed underline hover:text-accent"
                >
                  Start an evaluation →
                </Link>
              </p>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleItems.map((it) => {
              if (it.kind === "run_group") {
                return (
                  <RunGroupCard
                    key={`g-${it.data.key}`}
                    group={it.data}
                    projectId={projectId}
                    onOpenResults={openRunResults}
                  />
                );
              }
              if (it.kind === "eval") {
                return (
                  <EvalRow
                    key={`e-${it.data.id}`}
                    ev={it.data}
                    runType={it.runType}
                    datasetRunBadge={null}
                  />
                );
              }
              return (
                <ChatRow
                  key={`c-${it.data.id}`}
                  conv={it.data}
                  projectId={projectId}
                  runType={it.runType}
                />
              );
            })}
          </ul>
        )}
      </div>

      {runAllOpen && (
        <RunAllDialog
          project={project}
          onClose={() => setRunAllOpen(false)}
          onStarted={(ids) => {
            setRunAllOpen(false);
            setActiveRunIds(ids);
            queryClient.invalidateQueries({
              queryKey: ["datasets", projectId],
            });
            queryClient.invalidateQueries({
              queryKey: ["dataset-runs-by-project", projectId],
            });
            queryClient.invalidateQueries({
              queryKey: ["dataset-runs", "activity", projectId],
            });
          }}
        />
      )}
    </div>
  );
}

const RUN_TYPE_LABEL: Record<string, string> = {
  single: "SINGLE",
  multi_turn: "MULTI-TURN",
  dataset: "DATASET",
  scheduled: "SCHEDULED",
};

function RunTypeBadge({ runType }: { runType: RunType }) {
  const label = RUN_TYPE_LABEL[runType] ?? String(runType).toUpperCase();
  return (
    <span className="inline-flex h-[18px] items-center rounded-sm bg-surface-sunken px-1.5 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
      {label}
    </span>
  );
}

function MiniBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[18px] items-center rounded-sm bg-surface-sunken px-1.5 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
      {children}
    </span>
  );
}

function EvalRow({
  ev,
  runType,
  datasetRunBadge,
}: {
  ev: EvaluationSummary;
  runType: RunType;
  datasetRunBadge?: string | null;
}) {
  return (
    <li>
      <Link
        href={`/evaluations/${ev.id}`}
        className="flex items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2 transition-colors duration-fast ease-ev hover:bg-surface-sunken"
      >
        <FileText size={16} className="shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-[14px] leading-[20px] text-text">{ev.question}</p>
          <p className="truncate font-sans text-[13px] leading-[18px] text-text-muted">
            <span className="mr-1.5 inline-flex align-middle">
              <RunTypeBadge runType={runType} />
            </span>
            {datasetRunBadge ? (
              <span className="mr-1.5 inline-flex align-middle">
                <MiniBadge>{datasetRunBadge}</MiniBadge>
              </span>
            ) : null}
            {relativeTime(ev.created_at)} ·{" "}
            <span className="uppercase tracking-[0.04em]">{ev.method}</span>
            {(() => {
              const t =
                (ev.total_tokens ?? null) ??
                (ev.judge_total_tokens || ev.reference_total_tokens || ev.chatbot_total_tokens
                  ? (ev.judge_total_tokens ?? 0) +
                    (ev.reference_total_tokens ?? 0) +
                    (ev.chatbot_total_tokens ?? 0)
                  : null);
              if (!t) return null;
              return (
                <>
                  {" · "}
                  <span className="font-mono tabular-nums">
                    {new Intl.NumberFormat("en-US").format(t)}
                  </span>{" "}
                  tokens
                </>
              );
            })()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {ev.override_verdict ? (
            <span
              className="inline-flex h-[22px] items-center rounded-sm bg-accent-soft px-1.5 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-accent-pressed"
              title={`Manually overridden to ${ev.override_verdict}`}
            >
              ✎ override
            </span>
          ) : null}
          <ScoreBadge label="Score" value={ev.ai_score ?? ev.combined_score} primary />
        </div>
      </Link>
    </li>
  );
}

function ScoreBadge({
  label,
  value,
  primary,
}: {
  label: string;
  value: number | null | undefined;
  primary?: boolean;
}) {
  if (value === null || value === undefined) {
    return (
      <span className="inline-flex h-[22px] items-center gap-1 rounded-sm bg-surface-sunken px-1.5 font-mono text-[12px] tabular-nums text-text-subtle">
        <span className="font-sans text-[10px] uppercase tracking-[0.04em]">{label}</span>—
      </span>
    );
  }
  const { fgClass, bgClass } = scoreBandClasses(value);
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1 rounded-sm px-1.5 font-mono text-[12px] tabular-nums ${bgClass} ${fgClass} ${primary ? "font-semibold" : ""}`}
    >
      <span className="font-sans text-[10px] uppercase tracking-[0.04em] opacity-80">{label}</span>
      {value.toFixed(1)}
    </span>
  );
}

function ChatRow({
  conv,
  projectId,
  runType,
}: {
  conv: ConversationListItem;
  projectId: string;
  runType: RunType;
}) {
  return (
    <li>
      <Link
        href={`/projects/${projectId}?tab=evaluate&mode=multi&conv=${conv.id}`}
        className="flex items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2 transition-colors duration-fast ease-ev hover:bg-surface-sunken"
      >
        <MessageSquare size={16} className="shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-[14px] leading-[20px] text-text">
            {conv.title || "Untitled conversation"}
          </p>
          <p className="truncate font-sans text-[13px] leading-[18px] text-text-muted">
            <span className="mr-1.5 inline-flex align-middle">
              <RunTypeBadge runType={runType} />
            </span>
            {relativeTime(conv.created_at)} · {conv.turn_count} turns
          </p>
        </div>
        <Badge variant="info">chat</Badge>
        <span className="font-sans text-[13px] text-text-muted">Open →</span>
      </Link>
    </li>
  );
}

// Dataset-run cascade rendering moved to RunGroupCard in RunGroupsSection.
/* removed: DatasetRunCard, PassRateChip, DatasetRunHeatmapInline
function _RemovedDatasetRunCard({
  run,
  runIndex,
  datasetName,
}: {
  run: DatasetRun;
  runIndex: number;
  datasetName: string;
}) {
  const [open, setOpen] = React.useState(false);

  const passRate = run.summary?.pass_rate ?? null;
  const methodUpper = String(run.method ?? "BOTH").toUpperCase();
  const provider = run.ai_provider ? String(run.ai_provider).toUpperCase() : null;

  // Build dataset_row_id -> evaluation_id map from the pre-loaded run items
  // so each heatmap row can deep-link to its evaluation.
  const evalIdByRowId = React.useMemo(() => {
    const map = new Map<string, string>();
    run.items.forEach((it) => {
      if (it.evaluation_id) map.set(it.dataset_row_id, it.evaluation_id);
    });
    return map;
  }, [run.items]);

  return (
    <li className="rounded-md border border-border bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-fast ease-ev hover:bg-surface-sunken"
        aria-expanded={open}
      >
        <Database size={16} className="shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-[14px] leading-[20px] text-text">
            {run.name && run.name.trim().length > 0
              ? run.name
              : `Run #${runIndex} — ${datasetName}`}
          </p>
          {run.name && run.name.trim().length > 0 ? (
            <p className="truncate font-sans text-[12px] leading-[16px] text-text-subtle">
              {datasetName}
            </p>
          ) : null}
          <p className="truncate font-sans text-[13px] leading-[18px] text-text-muted">
            <span className="mr-1.5 inline-flex align-middle">
              <MiniBadge>{methodUpper}</MiniBadge>
            </span>
            {provider ? (
              <span className="mr-1.5 inline-flex align-middle">
                <MiniBadge>AI · {provider}</MiniBadge>
              </span>
            ) : null}
            {relativeTime(run.started_at)} · {String(run.status).toUpperCase()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <PassRateChip value={passRate} />
          <span className="inline-flex h-[22px] items-center rounded-sm bg-surface-sunken px-1.5 font-mono text-[12px] tabular-nums text-text-muted">
            {run.completed_rows}/{run.total_rows}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              window.open(
                `${API_BASE_URL}/api/analytics/dataset-report.pdf?dataset_id=${encodeURIComponent(run.dataset_id)}`,
                "_blank",
              );
            }}
            title="Download full dataset PDF (all runs)"
            aria-label="Download full dataset PDF (all runs)"
            className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-sm bg-surface-sunken text-text-muted transition-colors duration-fast ease-ev hover:bg-surface hover:text-text"
          >
            <FileDown size={13} aria-hidden />
          </button>
          {open ? (
            <ChevronDown size={16} className="text-text-muted" aria-hidden />
          ) : (
            <ChevronRight size={16} className="text-text-muted" aria-hidden />
          )}
        </div>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2">
          <DatasetRunHeatmapInline runId={run.id} evalIdByRowId={evalIdByRowId} />
        </div>
      ) : null}
    </li>
  );
}

function PassRateChip({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return (
      <span className="inline-flex h-[22px] items-center gap-1 rounded-sm bg-surface-sunken px-1.5 font-mono text-[12px] tabular-nums text-text-subtle">
        <span className="font-sans text-[10px] uppercase tracking-[0.04em]">PASS</span>—
      </span>
    );
  }
  // pass_rate is a 0..1 fraction in server payload; normalize defensively.
  const pct = value <= 1 ? value * 100 : value;
  const { fgClass, bgClass } = scoreBandClasses(pct);
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1 rounded-sm px-1.5 font-mono text-[12px] font-semibold tabular-nums ${bgClass} ${fgClass}`}
    >
      <span className="font-sans text-[10px] uppercase tracking-[0.04em] opacity-80">PASS</span>
      {pct.toFixed(0)}%
    </span>
  );
}

function DatasetRunHeatmapInline({
  runId,
  evalIdByRowId,
}: {
  runId: string;
  evalIdByRowId: Map<string, string>;
}) {
  const q = useQuery<DatasetRunHeatmap>({
    queryKey: ["dataset-run-heatmap", runId],
    queryFn: () => datasetsApi.getRunHeatmap(runId),
  });

  if (q.isLoading || !q.data) {
    return (
      <div className="flex flex-col gap-1.5 py-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-7 animate-pulse rounded-sm bg-surface-sunken"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  const rows = q.data.rows;
  if (rows.length === 0) {
    return (
      <p className="font-sans text-[13px] text-text-muted">No rows in this run.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => {
        const evalId = evalIdByRowId.get(row.row_id);
        const ai = row.engine_scores?.ai ?? null;
        const combined = row.combined_score;
        const scoreVal = ai ?? combined;
        return (
          <li
            key={row.row_id}
            className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-surface-sunken"
          >
            <FileText size={14} className="shrink-0 text-text-muted" aria-hidden />
            <p className="min-w-0 flex-1 truncate font-sans text-[13px] leading-[18px] text-text">
              {row.question || "—"}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <ScoreBadge label="Score" value={scoreVal} primary />
            </div>
            {evalId ? (
              <Link
                href={`/evaluations/${evalId}`}
                className="shrink-0 font-sans text-[12px] text-accent-pressed underline hover:text-accent"
              >
                View →
              </Link>
            ) : (
              <span className="shrink-0 font-sans text-[12px] text-text-subtle">—</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
*/

function CompareRunsButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const runNamesQ = useQuery({
    queryKey: ["analytics", "run-names", projectId],
    queryFn: () => api.analytics.runNames(projectId),
    enabled: open,
  });
  const runNames: RunNameItem[] = runNamesQ.data ?? [];
  const [base, setBase] = React.useState("");
  const [head, setHead] = React.useState("");
  React.useEffect(() => {
    if (runNames.length >= 2) {
      setBase(runNames[0].name);
      setHead(runNames[runNames.length - 1].name);
    }
  }, [runNames.length]);

  function confirm() {
    if (!base || !head || base === head) return;
    const url = `/projects/${projectId}?tab=analytics&view=regression&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;
    setOpen(false);
    router.push(url);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-accent bg-accent px-2.5 font-sans text-[12px] font-medium text-white transition-colors duration-fast ease-ev hover:bg-accent/90"
      >
        Compare runs
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Compare runs">
        {runNamesQ.isLoading ? (
          <p className="font-sans text-[13px] text-text-muted">Loading runs…</p>
        ) : runNames.length < 2 ? (
          <p className="font-sans text-[13px] text-text-muted">
            Need at least 2 run-groups to compare.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="block font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
                Base run
              </label>
              <Select selectSize="sm" value={base} onChange={(e) => setBase(e.target.value)}>
                {runNames.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
                Head run
              </label>
              <Select selectSize="sm" value={head} onChange={(e) => setHead(e.target.value)}>
                {runNames.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 rounded-md border border-border bg-surface px-3 font-sans text-[13px] text-text-muted hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!base || !head || base === head}
                onClick={confirm}
                className="h-8 rounded-md border border-accent bg-accent px-3 font-sans text-[13px] font-medium text-white disabled:opacity-50"
              >
                Compare
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
