"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileDown, X } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  API_BASE_URL,
  chatbotEndpointsApi,
  datasetsApi,
  type DatasetRun,
  type Project,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { scoreBandClasses } from "@/lib/scoreColor";

function bandFg(score: number): string {
  return scoreBandClasses(score).fgClass;
}
function bandBg(score: number): string {
  return scoreBandClasses(score).bgClass;
}

function statusVariant(
  status: string,
): "success" | "danger" | "warn" | "accent" | "neutral" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "warn";
  if (status === "running" || status === "pending") return "accent";
  return "neutral";
}

export interface RunGroup {
  key: string;
  name: string | null;
  startedAt: string;
  runs: DatasetRun[];
}

export function groupRuns(runs: DatasetRun[]): RunGroup[] {
  const map = new Map<string, RunGroup>();
  for (const r of runs) {
    const nm = (r.name ?? "").trim();
    const key = nm
      ? `name:${nm}`
      : `day:${new Date(r.started_at).toISOString().slice(0, 10)}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        name: nm || null,
        startedAt: r.started_at,
        runs: [],
      };
      map.set(key, g);
    }
    g.runs.push(r);
    if (new Date(r.started_at) < new Date(g.startedAt)) {
      g.startedAt = r.started_at;
    }
  }
  const groups = Array.from(map.values());
  groups.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  return groups;
}

export function RunGroupsSection({
  project,
  onOpenResults,
}: {
  project: Project;
  onOpenResults: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const projectId = project.id;

  const [runAllOpen, setRunAllOpen] = React.useState(false);
  const [activeRunIds, setActiveRunIds] = React.useState<string[]>([]);

  const q = useQuery<DatasetRun[]>({
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

  const groups = React.useMemo(() => groupRuns(q.data ?? []), [q.data]);

  return (
    <>
      {activeRunIds.length > 0 && (
        <RunAllProgressStrip
          runIds={activeRunIds}
          onDismiss={() => setActiveRunIds([])}
        />
      )}

      <Card>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>Run groups</CardTitle>
            <p className="mt-1 font-sans text-[12px] text-text-muted">
              Runs that share a name are grouped together. Expand to drill into
              per-dataset results.
            </p>
          </div>
          <Button size="sm" onClick={() => setRunAllOpen(true)}>
            Run all datasets
          </Button>
        </div>
        {q.isLoading ? (
          <p className="mt-3 font-sans text-[14px] text-text-muted">
            Loading runs…
          </p>
        ) : groups.length === 0 ? (
          <p className="mt-3 font-sans text-[13px] text-text-muted">
            No run groups yet — click “Run all datasets” to kick off a retest.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {groups.map((g) => (
              <RunGroupCard
                key={g.key}
                group={g}
                projectId={projectId}
                onOpenResults={onOpenResults}
              />
            ))}
          </ul>
        )}
      </Card>

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
    </>
  );
}

export function RunGroupCard({
  group,
  projectId,
  onOpenResults,
}: {
  group: RunGroup;
  projectId: string;
  onOpenResults: (runId: string) => void;
}) {
  const [open, setOpen] = React.useState(false);

  let totalEvals = 0;
  let totalCompleted = 0;
  let totalFindings = 0;
  const passVals: number[] = [];
  const avgVals: number[] = [];
  let anyInFlight = false;
  for (const r of group.runs) {
    totalEvals += r.total_rows;
    totalCompleted += r.completed_rows;
    if (r.summary) {
      if (r.summary.pass_rate != null) passVals.push(r.summary.pass_rate);
      if (r.summary.avg_combined != null) avgVals.push(r.summary.avg_combined);
    }
    for (const it of r.items ?? []) {
      const s = it.ai_score ?? it.combined_score;
      if (s != null && s < 75) totalFindings += 1;
    }
    if (r.status === "pending" || r.status === "running") anyInFlight = true;
  }
  const aggPass = passVals.length
    ? passVals.reduce((a, b) => a + b, 0) / passVals.length
    : null;
  const aggAvg = avgVals.length
    ? avgVals.reduce((a, b) => a + b, 0) / avgVals.length
    : null;

  const displayName = group.name || "(unnamed run group)";

  return (
    <li className="rounded-md border border-border bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-fast ease-ev hover:bg-surface-sunken"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={16} className="text-text-muted shrink-0" aria-hidden />
        ) : (
          <ChevronRight size={16} className="text-text-muted shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-[14px] font-semibold leading-[20px] text-text">
            {displayName}
          </p>
          <p className="truncate font-sans text-[12px] leading-[16px] text-text-muted">
            {new Date(group.startedAt).toLocaleString()} · {group.runs.length}{" "}
            dataset{group.runs.length === 1 ? "" : "s"} · {totalCompleted}/
            {totalEvals} evals
            {anyInFlight ? " · running" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {aggPass != null && (
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 font-mono text-[12px] tabular-nums",
                bandFg(aggPass * 100),
                bandBg(aggPass * 100),
              )}
              title="Aggregate pass rate"
            >
              {Math.round(aggPass * 100)}%
            </span>
          )}
          {aggAvg != null && (
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 font-mono text-[12px] tabular-nums",
                bandFg(aggAvg),
              )}
              title="Aggregate avg score"
            >
              {aggAvg.toFixed(1)}
            </span>
          )}
          <span className="font-mono text-[12px] tabular-nums text-text-muted">
            {totalFindings} findings
          </span>
          {group.name ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                window.open(
                  `${API_BASE_URL}/api/analytics/run-group-report.pdf?project_id=${encodeURIComponent(projectId)}&run_name=${encodeURIComponent(group.name as string)}`,
                  "_blank",
                );
              }}
              title="Download PDF report for this run group (all datasets)"
              aria-label="Download PDF report for this run group"
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-sm bg-surface-sunken text-text-muted transition-colors duration-fast ease-ev hover:bg-surface hover:text-text"
            >
              <FileDown size={13} aria-hidden />
            </button>
          ) : null}
        </div>
      </button>
      {open && (
        <ul className="border-t border-border">
          {group.runs.map((r) => {
            const passRate = r.summary?.pass_rate;
            const avg = r.summary?.avg_combined;
            return (
              <li
                key={r.id}
                className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOpenResults(r.id)}
                    className="truncate font-sans text-[13px] text-text hover:underline"
                  >
                    {r.dataset_id ? <DatasetNameLabel runId={r.id} /> : "Dataset"}
                  </button>
                  <p className="truncate font-sans text-[12px] text-text-muted">
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>{" "}
                    · {r.completed_rows}/{r.total_rows} evals
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {passRate != null && (
                    <span
                      className={cn(
                        "rounded-sm px-1.5 py-0.5 font-mono text-[12px] tabular-nums",
                        bandFg(passRate * 100),
                        bandBg(passRate * 100),
                      )}
                    >
                      {Math.round(passRate * 100)}%
                    </span>
                  )}
                  {avg != null && (
                    <span
                      className={cn(
                        "font-mono text-[12px] tabular-nums",
                        bandFg(avg),
                      )}
                    >
                      {avg.toFixed(1)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenResults(r.id)}
                    className="font-sans text-[12px] text-accent-pressed underline hover:text-accent"
                  >
                    View
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function DatasetNameLabel({ runId }: { runId: string }) {
  const q = useQuery<DatasetRun>({
    queryKey: ["dataset-run-name", runId],
    queryFn: () => datasetsApi.getRun(runId),
    staleTime: 60_000,
  });
  const datasetId = q.data?.dataset_id;
  const dsQ = useQuery({
    queryKey: ["dataset-name", datasetId],
    queryFn: () => datasetsApi.get(datasetId as string),
    enabled: !!datasetId,
    staleTime: 60_000,
  });
  return <span>{dsQ.data?.name ?? "Dataset"}</span>;
}

export function RunAllDialog({
  project,
  onClose,
  onStarted,
}: {
  project: Project;
  onClose: () => void;
  onStarted: (runIds: string[]) => void;
}) {
  const [name, setName] = React.useState<string>(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `Run on ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  });
  const [endpointId, setEndpointId] = React.useState<string>("");
  const [provider, setProvider] = React.useState<string>("");

  const endpointsQ = useQuery({
    queryKey: ["chatbot-endpoints", project.id],
    queryFn: () => chatbotEndpointsApi.list(project.id),
  });
  const datasetsQ = useQuery({
    queryKey: ["datasets", project.id],
    queryFn: () => datasetsApi.listByProject(project.id),
  });

  React.useEffect(() => {
    if (!endpointId && endpointsQ.data && endpointsQ.data.length > 0) {
      const def =
        endpointsQ.data.find((e) => e.is_default) ?? endpointsQ.data[0];
      setEndpointId(def.id);
    }
  }, [endpointsQ.data, endpointId]);

  const runMut = useMutation({
    mutationFn: () =>
      datasetsApi.runAll(project.id, {
        method: "ai",
        ai_provider: provider || null,
        chatbot_endpoint_id: endpointId || null,
        name: name.trim() || null,
        tag_filter: [],
      }),
    onSuccess: (res) => onStarted(res.runs.map((r) => r.id)),
  });

  const endpoints = endpointsQ.data ?? [];
  const datasets = datasetsQ.data ?? [];

  return (
    <Dialog open onClose={onClose} title="Run all datasets">
      <div className="flex flex-col gap-3">
        <p className="font-sans text-[13px] text-text-muted">
          This will run all {datasets.length} dataset
          {datasets.length === 1 ? "" : "s"} as one logical run group.
        </p>
        <div className="flex flex-col gap-1.5">
          <label className="font-sans text-[13px] font-medium text-text uppercase tracking-[0.04em]">
            Run name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Final retest — 2026-01-12"
          />
          <p className="font-sans text-[12px] text-text-muted">
            Each per-dataset run will share this name, so they show as a single
            cascade card.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="font-sans text-[13px] font-medium text-text uppercase tracking-[0.04em]">
            Chatbot endpoint
          </label>
          {endpoints.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-2 font-sans text-[12px] text-text-muted">
              No endpoints configured — manual responses only.
            </p>
          ) : (
            <Select
              value={endpointId}
              onChange={(e) => setEndpointId(e.target.value)}
            >
              <option value="">Manual responses only</option>
              {endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.name}
                  {ep.is_default ? " (default)" : ""}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="font-sans text-[13px] font-medium text-text uppercase tracking-[0.04em]">
            Judge AI provider
          </label>
          <Select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">Default</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="ollama">Ollama</option>
          </Select>
        </div>
        {runMut.error instanceof Error && (
          <p className="font-sans text-[13px] text-danger">
            {runMut.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={runMut.isPending} onClick={() => runMut.mutate()}>
            {runMut.isPending ? "Starting…" : "Run all"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function RunAllProgressStrip({
  runIds,
  onDismiss,
}: {
  runIds: string[];
  onDismiss: () => void;
}) {
  const q = useQuery<DatasetRun[]>({
    queryKey: ["run-all-progress", runIds.join(",")],
    queryFn: async () => {
      const results = await Promise.all(
        runIds.map((id) => datasetsApi.getRun(id)),
      );
      return results;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1500;
      const inFlight = data.some(
        (r) => r.status === "pending" || r.status === "running",
      );
      return inFlight ? 1500 : false;
    },
  });

  const runs = q.data ?? [];
  const done = runs.filter(
    (r) => r.status !== "pending" && r.status !== "running",
  ).length;
  const total = runIds.length;
  const allDone = done === total && total > 0;

  return (
    <Card className="border-accent/40 bg-accent-soft/10">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[14px] font-medium text-text">
            {allDone
              ? "Run all datasets — completed"
              : "Run all datasets — running"}
          </p>
          <p className="font-sans text-[12px] text-text-muted">
            {done}/{total} sub-runs finished
          </p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-surface-sunken overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-500 ease-out"
              style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
            />
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <X size={14} aria-hidden /> Dismiss
        </Button>
      </div>
    </Card>
  );
}
