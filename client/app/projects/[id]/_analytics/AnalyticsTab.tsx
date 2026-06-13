"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardTitle } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import {
  api,
  API_BASE_URL,
  type AnalyticsSummary,
  type AnalyticsParams,
  type EvaluationListItem,
  type FailureCluster,
  type Project,
  type RegressionItem,
  type RegressionResponse,
  type SeverityTrendPoint,
  type TopTokenEvaluation,
  type RunNameItem,
} from "@/lib/api";
import { scoreBandClasses } from "@/lib/scoreColor";

const ACCENT = "#D97757";

type AnalyticsView = "overview" | "regression" | "tokens";

const VIEWS: { key: AnalyticsView; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "regression", label: "Regression" },
  { key: "tokens", label: "Tokens" },
];

const DATE_RANGES: { value: string; label: string }[] = [
  { value: "project", label: "Project range" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export function AnalyticsTab({ project }: { project: Project }) {
  const searchParams = useSearchParams();
  const initialView = ((): AnalyticsView => {
    const v = searchParams.get("view");
    if (v === "overview" || v === "regression" || v === "tokens") return v;
    return "overview";
  })();
  const [view, setView] = React.useState<AnalyticsView>(initialView);
  React.useEffect(() => {
    setView(initialView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get("view")]);
  // Default to the project's own date span so charts populate immediately —
  // historical / seed datasets often live outside a rolling 30-day window.
  const [dateRange, setDateRange] = React.useState<string>("project");

  const projectRange = useQuery({
    queryKey: ["analytics", "date-range", project.id],
    queryFn: () => api.analytics.dateRange(project.id),
  });

  const queryParams = React.useMemo<AnalyticsParams>(() => {
    const base: AnalyticsParams = { project_id: project.id };
    if (dateRange === "project") {
      const min = projectRange.data?.min;
      const max = projectRange.data?.max;
      if (min) base.since = min;
      if (max) base.until = max;
      return base;
    }
    if (dateRange === "all") return base;
    const days = Number(dateRange);
    if (Number.isFinite(days) && days > 0) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      base.since = since.toISOString();
    }
    return base;
  }, [project.id, dateRange, projectRange.data?.min, projectRange.data?.max]);

  const summary = useQuery({
    queryKey: ["analytics", "summary", queryParams],
    queryFn: () => api.analytics.summary(queryParams),
  });

  const evaluations = useQuery({
    queryKey: ["evaluations", "analytics", queryParams],
    queryFn: () => api.evaluations.list({ ...queryParams, limit: 500 }),
  });

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <span className="mr-1 font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
          Filters
        </span>
        <div className="w-[160px]">
          <Select selectSize="sm" value={dateRange} onChange={(e) => setDateRange(e.target.value)}>
            {DATE_RANGES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() =>
              window.open(
                `${API_BASE_URL}/api/analytics/report.pdf?project_id=${encodeURIComponent(project.id)}`,
                "_blank",
              )
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent px-3 font-sans text-[13px] font-medium text-white transition-colors duration-fast ease-ev hover:bg-accent/90"
          >
            Download PDF report
          </button>
        </div>
      </div>

      <SummaryTiles data={summary.data} loading={summary.isLoading} />

      <Views view={view} onChange={setView} />

      {view === "overview" && (
        <>
          <ActivityChart evaluations={evaluations.data ?? []} />
          <SeverityTrendCard projectId={project.id} />
        </>
      )}
      {view === "regression" && <RegressionView projectId={project.id} />}
      {view === "tokens" && <TokensView projectId={project.id} />}
    </>
  );
}

function SummaryTiles({ data, loading }: { data: AnalyticsSummary | undefined; loading: boolean }) {
  const passRate = data?.pass_rate ?? null;
  const avgScore = data?.average_score ?? null;
  const passCls = passRate != null ? scoreBandClasses(passRate) : null;
  const avgCls = avgScore != null ? scoreBandClasses(avgScore) : null;

  const tiles: {
    label: string;
    value: string;
    fg?: string;
  }[] = [
    {
      label: "Pass Rate",
      value: passRate != null ? `${Math.round(passRate)}%` : "—",
      fg: passCls?.fgClass,
    },
    {
      label: "Avg Score",
      value: fmtNum(avgScore ?? undefined),
      fg: avgCls?.fgClass,
    },
    {
      label: "Total Evaluations",
      value: fmtInt(data?.total_evaluations),
    },
    {
      label: "Latest Run",
      value: fmtInt(data?.latest_run_count ?? data?.this_week),
    },
    {
      label: "Total Tokens",
      value: data
        ? new Intl.NumberFormat("en-US").format(data.total_tokens ?? 0)
        : "—",
    },
  ];

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-lg border border-border bg-surface-raised px-3 py-2.5"
        >
          <div className="font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-subtle">
            {t.label}
          </div>
          <div
            className={
              "mt-0.5 font-mono text-[22px] font-medium tabular-nums leading-[28px] " +
              (t.fg ?? "text-text")
            }
          >
            {loading ? "—" : t.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtInt(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return Math.round(n).toString();
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return n.toFixed(1);
}

function Views({ view, onChange }: { view: AnalyticsView; onChange: (t: AnalyticsView) => void }) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-border">
      {VIEWS.map((t) => {
        const active = t.key === view;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={[
              "-mb-px h-9 border-b-2 px-4 font-sans text-[14px] transition-colors duration-fast ease-ev",
              active
                ? "border-accent text-text"
                : "border-transparent text-text-muted hover:text-text",
            ].join(" ")}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function ActivityChart({ evaluations }: { evaluations: EvaluationListItem[] }) {
  const data = React.useMemo(() => bucketByDay(evaluations), [evaluations]);

  return (
    <Card className="mb-4">
      <CardTitle>Score &amp; Pass-rate Trend</CardTitle>
      <p className="mt-1 font-sans text-[13px] text-text-muted">
        Daily average combined score and pass rate.
      </p>
      <div className="mt-3 h-[300px]">
        {data.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <defs>
                <linearGradient id="scoreFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="passFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3D6A8C" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#3D6A8C" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#E5E2D6" strokeDasharray="3 3" />
              <XAxis dataKey="day" stroke="#6B6A63" tick={{ fontSize: 12 }} />
              <YAxis
                domain={[0, 100]}
                stroke="#6B6A63"
                tick={{ fontSize: 12 }}
                tickFormatter={(v) => `${v}`}
              />
              <Tooltip
                contentStyle={{
                  background: "#FFFFFF",
                  border: "1px solid #E5E2D6",
                  borderRadius: 10,
                  fontSize: 13,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="avg"
                stroke={ACCENT}
                strokeWidth={2}
                fill="url(#scoreFill)"
                name="Avg score"
              />
              <Area
                type="monotone"
                dataKey="passPct"
                stroke="#3D6A8C"
                strokeWidth={2}
                fill="url(#passFill)"
                name="Pass rate %"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function bucketByDay(
  evaluations: EvaluationListItem[],
): { day: string; avg: number; count: number; passPct: number }[] {
  const buckets = new Map<string, { sum: number; count: number; pass: number }>();
  for (const ev of evaluations) {
    if (ev.combined_score === null || ev.combined_score === undefined) continue;
    const d = new Date(ev.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const cur = buckets.get(key) ?? { sum: 0, count: 0, pass: 0 };
    cur.sum += ev.combined_score;
    cur.count += 1;
    if (ev.combined_score >= 75) cur.pass += 1;
    buckets.set(key, cur);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({
      day: day.slice(5),
      avg: Number((v.sum / v.count).toFixed(2)),
      count: v.count,
      passPct: Number(((v.pass / v.count) * 100).toFixed(0)),
    }));
}

const DEFAULT_DIMENSIONS = ["similarity", "completeness", "accuracy", "relevance", "readability"];

function CategoryDimensionMatrix({ evaluations }: { evaluations: EvaluationListItem[] }) {
  const { categories, dimensions, cells } = React.useMemo(
    () => aggregateMatrix(evaluations),
    [evaluations],
  );

  return (
    <Card>
      <CardTitle>Performance by Category &amp; Dimension</CardTitle>
      <p className="mt-1 font-sans text-[13px] text-text-muted">
        Average dimension scores, grouped by question category.
      </p>
      {categories.length === 0 || categories.every((c) => Object.keys(cells[c] ?? {}).length === 0) ? (
        <p className="mt-4 font-sans text-[14px] text-text-muted">
          No dimension data yet. Run a few evaluations and they&rsquo;ll show up here.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left font-sans text-[12px] uppercase tracking-[0.04em] text-text-muted">
                  Category
                </th>
                {dimensions.map((d) => (
                  <th
                    key={d}
                    className="px-3 py-2 text-right font-sans text-[12px] uppercase tracking-[0.04em] text-text-muted"
                  >
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c} className="border-t border-border">
                  <td className="px-3 py-2 font-sans text-[14px] text-text">{c}</td>
                  {dimensions.map((d) => {
                    const v = cells[c]?.[d];
                    if (v === undefined) {
                      return (
                        <td key={d} className="px-3 py-2 text-right text-text-subtle">
                          —
                        </td>
                      );
                    }
                    const { bgClass, fgClass } = scoreBandClasses(v);
                    return (
                      <td key={d} className="px-1 py-1 text-right">
                        <span
                          className={`inline-block min-w-[64px] rounded-sm px-2 py-1 font-mono text-[13px] tabular-nums ${bgClass} ${fgClass}`}
                        >
                          {v.toFixed(1)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function aggregateMatrix(evaluations: EvaluationListItem[]): {
  categories: string[];
  dimensions: string[];
  cells: Record<string, Record<string, number>>;
} {
  const sums: Record<string, Record<string, { sum: number; count: number }>> = {};
  const dimensionSet = new Set<string>();

  for (const ev of evaluations) {
    const category = ev.category ?? "Uncategorized";
    const dims = ev.dimensions ?? {};
    const hasDims = Object.keys(dims).length > 0;
    if (!hasDims && ev.combined_score !== null && ev.combined_score !== undefined) {
      DEFAULT_DIMENSIONS.forEach((d) => dimensionSet.add(d));
    }
    const source = hasDims ? dims : {};
    Object.keys(source).forEach((d) => dimensionSet.add(d));
    if (!sums[category]) sums[category] = {};
    for (const d of Object.keys(source)) {
      const cell = sums[category][d] ?? { sum: 0, count: 0 };
      cell.sum += source[d];
      cell.count += 1;
      sums[category][d] = cell;
    }
  }

  const dimensions = dimensionSet.size > 0 ? Array.from(dimensionSet) : DEFAULT_DIMENSIONS;
  const categories = Object.keys(sums).sort();
  const cells: Record<string, Record<string, number>> = {};
  for (const c of categories) {
    cells[c] = {};
    for (const d of dimensions) {
      const v = sums[c][d];
      if (v && v.count > 0) cells[c][d] = v.sum / v.count;
    }
  }
  return { categories, dimensions, cells };
}

// ---------------------------------------------------------------------------
// Performance view — token usage trends
// ---------------------------------------------------------------------------

function PerformanceView({ evaluations }: { evaluations: EvaluationListItem[] }) {
  const series = React.useMemo(() => bucketTokensByDay(evaluations), [evaluations]);
  const totals = React.useMemo(() => {
    let judge = 0,
      ref = 0,
      bot = 0;
    for (const ev of evaluations) {
      judge += ev.judge_total_tokens ?? 0;
      ref += ev.reference_total_tokens ?? 0;
      bot += ev.chatbot_total_tokens ?? 0;
    }
    return { judge, ref, bot, total: judge + ref + bot };
  }, [evaluations]);
  const avgPer = evaluations.length > 0 ? totals.total / evaluations.length : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Judge tokens" value={fmtTokens(totals.judge)} />
        <StatTile label="Reference tokens" value={fmtTokens(totals.ref)} />
        <StatTile label="Chatbot tokens" value={fmtTokens(totals.bot)} />
        <StatTile label="Avg / evaluation" value={fmtTokens(Math.round(avgPer))} />
      </div>

      <Card>
        <CardTitle>Token Usage Over Time</CardTitle>
        <p className="mt-1 font-sans text-[13px] text-text-muted">
          Daily total tokens, split by judge / reference / chatbot.
        </p>
        <div className="mt-3 h-[300px]">
          {series.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <defs>
                  <linearGradient id="judgeFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#D97757" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#D97757" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="refFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3D6A8C" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#3D6A8C" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="botFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#A38C57" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#A38C57" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#E5E2D6" strokeDasharray="3 3" />
                <XAxis dataKey="day" stroke="#6B6A63" tick={{ fontSize: 12 }} />
                <YAxis stroke="#6B6A63" tick={{ fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    background: "#FFFFFF",
                    border: "1px solid #E5E2D6",
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="judge"
                  stackId="t"
                  stroke="#D97757"
                  fill="url(#judgeFill)"
                  name="Judge"
                />
                <Area
                  type="monotone"
                  dataKey="reference"
                  stackId="t"
                  stroke="#3D6A8C"
                  fill="url(#refFill)"
                  name="Reference"
                />
                <Area
                  type="monotone"
                  dataKey="chatbot"
                  stackId="t"
                  stroke="#A38C57"
                  fill="url(#botFill)"
                  name="Chatbot"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>
    </div>
  );
}

function bucketTokensByDay(
  evaluations: EvaluationListItem[],
): { day: string; judge: number; reference: number; chatbot: number }[] {
  const buckets = new Map<
    string,
    { judge: number; reference: number; chatbot: number }
  >();
  for (const ev of evaluations) {
    const d = new Date(ev.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const cur = buckets.get(key) ?? { judge: 0, reference: 0, chatbot: 0 };
    cur.judge += ev.judge_total_tokens ?? 0;
    cur.reference += ev.reference_total_tokens ?? 0;
    cur.chatbot += ev.chatbot_total_tokens ?? 0;
    buckets.set(key, cur);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day: day.slice(5), ...v }));
}

// ---------------------------------------------------------------------------
// Quality view — score distribution + dimension averages
// ---------------------------------------------------------------------------

function QualityView({ evaluations }: { evaluations: EvaluationListItem[] }) {
  const distribution = React.useMemo(() => scoreDistribution(evaluations), [evaluations]);
  const dimAverages = React.useMemo(() => dimensionAverages(evaluations), [evaluations]);

  const passCount = evaluations.filter(
    (e) => (e.combined_score ?? 0) >= 75,
  ).length;
  const failCount = evaluations.filter(
    (e) => e.combined_score != null && e.combined_score < 75,
  ).length;
  const noScore = evaluations.length - passCount - failCount;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile label="Passed" value={String(passCount)} accent="success" />
        <StatTile label="Failed" value={String(failCount)} accent="danger" />
        <StatTile label="No score" value={String(noScore)} />
      </div>

      <Card>
        <CardTitle>Score Distribution</CardTitle>
        <p className="mt-1 font-sans text-[13px] text-text-muted">
          Evaluations grouped by combined score band.
        </p>
        {distribution.every((d) => d.count === 0) ? (
          <p className="mt-4 font-sans text-[14px] text-text-muted">No data yet.</p>
        ) : (
          (() => {
            const max = Math.max(1, ...distribution.map((d) => d.count));
            return (
              <ul className="mt-4 flex flex-col gap-3">
                {distribution.map((d) => {
                  const pct = (d.count / max) * 100;
                  return (
                    <li key={d.bucket} className="flex items-center gap-3">
                      <span className="w-[64px] shrink-0 font-mono text-[12px] tabular-nums text-text-muted">
                        {d.bucket}
                      </span>
                      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${pct}%`, background: d.color }}
                        />
                      </div>
                      <span className="w-[40px] shrink-0 text-right font-mono text-[13px] tabular-nums text-text">
                        {d.count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            );
          })()
        )}
      </Card>

      <Card>
        <CardTitle>Dimension Averages</CardTitle>
        <p className="mt-1 font-sans text-[13px] text-text-muted">
          Mean score per dimension across all evaluations.
        </p>
        {dimAverages.length === 0 ? (
          <p className="mt-4 font-sans text-[14px] text-text-muted">No data yet.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {dimAverages.map((d) => {
              const cls = scoreBandClasses(d.value);
              return (
                <li key={d.name} className="flex items-center gap-3">
                  <span className="w-[120px] shrink-0 font-sans text-[13px] capitalize text-text">
                    {d.name.replace(/_/g, " ")}
                  </span>
                  <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className={"h-full rounded-full " + cls.bgClass.replace("bg-", "bg-")}
                      style={{ width: `${Math.max(0, Math.min(100, d.value))}%` }}
                    />
                  </div>
                  <span
                    className={
                      "w-[48px] shrink-0 text-right font-mono text-[13px] tabular-nums " +
                      cls.fgClass
                    }
                  >
                    {d.value.toFixed(1)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function scoreDistribution(
  evaluations: EvaluationListItem[],
): { bucket: string; count: number; color: string }[] {
  const buckets = [
    { bucket: "0–20", min: 0, max: 20, color: "#B5532E", count: 0 },
    { bucket: "20–40", min: 20, max: 40, color: "#C76F46", count: 0 },
    { bucket: "40–60", min: 40, max: 60, color: "#D69258", count: 0 },
    { bucket: "60–80", min: 60, max: 80, color: "#A8A270", count: 0 },
    { bucket: "80–100", min: 80, max: 100.01, color: "#6E8A5C", count: 0 },
  ];
  for (const ev of evaluations) {
    const s = ev.combined_score;
    if (s == null) continue;
    for (const b of buckets) {
      if (s >= b.min && s < b.max) {
        b.count += 1;
        break;
      }
    }
  }
  return buckets.map(({ bucket, count, color }) => ({ bucket, count, color }));
}

function dimensionAverages(
  evaluations: EvaluationListItem[],
): { name: string; value: number }[] {
  const sums: Record<string, { sum: number; count: number }> = {};
  for (const ev of evaluations) {
    const dims = ev.dimensions ?? {};
    for (const [k, v] of Object.entries(dims)) {
      if (typeof v !== "number" || Number.isNaN(v)) continue;
      const cur = sums[k] ?? { sum: 0, count: 0 };
      cur.sum += v;
      cur.count += 1;
      sums[k] = cur;
    }
  }
  return Object.entries(sums)
    .map(([name, v]) => ({ name, value: Number((v.sum / v.count).toFixed(1)) }))
    .sort((a, b) => b.value - a.value);
}

// ---------------------------------------------------------------------------
// Content view — category breakdown + worst-performing questions
// ---------------------------------------------------------------------------

function ContentView({ evaluations }: { evaluations: EvaluationListItem[] }) {
  const categories = React.useMemo(() => categoryStats(evaluations), [evaluations]);
  const worst = React.useMemo(() => worstQuestions(evaluations), [evaluations]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Category Performance</CardTitle>
        <p className="mt-1 font-sans text-[13px] text-text-muted">
          Pass rate and average score per question category.
        </p>
        {categories.length === 0 ? (
          <p className="mt-4 font-sans text-[14px] text-text-muted">No data yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th align="left">Category</Th>
                  <Th align="right">Evals</Th>
                  <Th align="right">Pass rate</Th>
                  <Th align="right">Avg score</Th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => {
                  const passClass = scoreBandClasses(c.passRate);
                  const avgClass = scoreBandClasses(c.avg);
                  return (
                    <tr key={c.category} className="border-t border-border">
                      <td className="px-3 py-2 font-sans text-[14px] text-text">
                        {c.category}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[13px] tabular-nums text-text-muted">
                        {c.count}
                      </td>
                      <td className="px-1 py-1 text-right">
                        <span
                          className={`inline-block min-w-[68px] rounded-sm px-2 py-1 font-mono text-[13px] tabular-nums ${passClass.bgClass} ${passClass.fgClass}`}
                        >
                          {Math.round(c.passRate)}%
                        </span>
                      </td>
                      <td className="px-1 py-1 text-right">
                        <span
                          className={`inline-block min-w-[64px] rounded-sm px-2 py-1 font-mono text-[13px] tabular-nums ${avgClass.bgClass} ${avgClass.fgClass}`}
                        >
                          {c.avg.toFixed(1)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Worst-performing Questions</CardTitle>
        <p className="mt-1 font-sans text-[13px] text-text-muted">
          Questions with the lowest average score (min 2 evaluations).
        </p>
        {worst.length === 0 ? (
          <p className="mt-4 font-sans text-[14px] text-text-muted">No data yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {worst.map((w) => {
              const cls = scoreBandClasses(w.avg);
              return (
                <li
                  key={w.question}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-text">
                    {w.question}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-subtle">
                    {w.count}×
                  </span>
                  <span
                    className={`inline-block min-w-[60px] rounded-sm px-2 py-1 text-right font-mono text-[13px] tabular-nums ${cls.bgClass} ${cls.fgClass}`}
                  >
                    {w.avg.toFixed(1)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function categoryStats(
  evaluations: EvaluationListItem[],
): { category: string; count: number; passRate: number; avg: number }[] {
  const m = new Map<string, { sum: number; count: number; pass: number }>();
  for (const ev of evaluations) {
    if (ev.combined_score == null) continue;
    const cat = ev.category ?? "Uncategorized";
    const cur = m.get(cat) ?? { sum: 0, count: 0, pass: 0 };
    cur.sum += ev.combined_score;
    cur.count += 1;
    if (ev.combined_score >= 75) cur.pass += 1;
    m.set(cat, cur);
  }
  return Array.from(m.entries())
    .map(([category, v]) => ({
      category,
      count: v.count,
      passRate: (v.pass / v.count) * 100,
      avg: v.sum / v.count,
    }))
    .sort((a, b) => b.count - a.count);
}

function worstQuestions(
  evaluations: EvaluationListItem[],
): { question: string; count: number; avg: number }[] {
  const m = new Map<string, { sum: number; count: number }>();
  for (const ev of evaluations) {
    if (ev.combined_score == null) continue;
    const q = (ev.question ?? "").trim();
    if (!q) continue;
    const cur = m.get(q) ?? { sum: 0, count: 0 };
    cur.sum += ev.combined_score;
    cur.count += 1;
    m.set(q, cur);
  }
  return Array.from(m.entries())
    .filter(([, v]) => v.count >= 2)
    .map(([question, v]) => ({
      question,
      count: v.count,
      avg: v.sum / v.count,
    }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Shared mini components
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "danger";
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="font-sans text-[12px] uppercase tracking-[0.04em] text-text-muted">
        {label}
      </span>
      <span
        className={
          "font-mono text-[18px] font-medium tabular-nums " +
          (accent === "success"
            ? "text-success"
            : accent === "danger"
              ? "text-danger"
              : "text-text")
        }
      >
        {value}
      </span>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align: "left" | "right" }) {
  return (
    <th
      className={
        "px-3 py-2 font-sans text-[12px] uppercase tracking-[0.04em] text-text-muted " +
        (align === "right" ? "text-right" : "text-left")
      }
    >
      {children}
    </th>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center font-sans text-[14px] text-text-muted">
      No data yet.
    </div>
  );
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

// ---------------------------------------------------------------------------
// Overview side-cards: provider mix + run-type mix
// ---------------------------------------------------------------------------

function ProviderBreakdown({ evaluations }: { evaluations: EvaluationListItem[] }) {
  const rows = React.useMemo(() => groupBy(evaluations, (e) => e.ai_provider ?? "—"), [
    evaluations,
  ]);
  return (
    <Card>
      <CardTitle>Provider Mix</CardTitle>
      <p className="mt-1 font-sans text-[13px] text-text-muted">
        Evaluations grouped by judge AI provider.
      </p>
      <BarList rows={rows} colorFor={() => "#3D6A8C"} />
    </Card>
  );
}

function RunTypeBreakdown({ evaluations }: { evaluations: EvaluationListItem[] }) {
  const rows = React.useMemo(
    () =>
      groupBy(evaluations, (e) => {
        const t = e.run_type ?? "single";
        return t.charAt(0).toUpperCase() + t.slice(1);
      }),
    [evaluations],
  );
  return (
    <Card>
      <CardTitle>Run Type</CardTitle>
      <p className="mt-1 font-sans text-[13px] text-text-muted">
        Single, dataset, and scheduled runs.
      </p>
      <BarList rows={rows} colorFor={() => "#A38C57"} />
    </Card>
  );
}

function groupBy<T extends EvaluationListItem>(
  items: T[],
  key: (e: T) => string,
): { label: string; count: number; avg: number | null }[] {
  const m = new Map<string, { count: number; sum: number; scored: number }>();
  for (const ev of items) {
    const k = key(ev);
    const cur = m.get(k) ?? { count: 0, sum: 0, scored: 0 };
    cur.count += 1;
    if (ev.combined_score != null) {
      cur.sum += ev.combined_score;
      cur.scored += 1;
    }
    m.set(k, cur);
  }
  return Array.from(m.entries())
    .map(([label, v]) => ({
      label,
      count: v.count,
      avg: v.scored > 0 ? v.sum / v.scored : null,
    }))
    .sort((a, b) => b.count - a.count);
}

function BarList({
  rows,
  colorFor,
}: {
  rows: { label: string; count: number; avg: number | null }[];
  colorFor: (label: string) => string;
}) {
  if (rows.length === 0) {
    return <p className="mt-4 font-sans text-[14px] text-text-muted">No data yet.</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="mt-3 flex flex-col gap-2.5">
      {rows.map((r) => {
        const pct = (r.count / max) * 100;
        return (
          <li key={r.label} className="flex items-center gap-3">
            <span className="w-[100px] shrink-0 truncate font-sans text-[13px] capitalize text-text">
              {r.label}
            </span>
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, background: colorFor(r.label) }}
              />
            </div>
            <span className="w-[42px] shrink-0 text-right font-mono text-[13px] tabular-nums text-text">
              {r.count}
            </span>
            <span className="w-[44px] shrink-0 text-right font-mono text-[12px] tabular-nums text-text-subtle">
              {r.avg != null ? r.avg.toFixed(1) : "—"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Alphabin demo features
// ---------------------------------------------------------------------------

function SeverityTrendCard({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: ["analytics", "severity-trend", projectId],
    queryFn: () => api.analytics.severityTrend(projectId),
  });
  const series: SeverityTrendPoint[] = q.data?.series ?? [];
  return (
    <Card className="mb-4">
      <CardTitle>Severity Trend</CardTitle>
      <p className="mt-1 font-sans text-[13px] text-text-muted">
        Critical / major / minor finding counts across each run-group.
      </p>
      <div className="mt-3 h-[260px]">
        {series.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series.map((s) => ({
                run: shortLabel(s.run_name),
                critical: s.critical,
                major: s.major,
                minor: s.minor,
              }))}
              margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
            >
              <CartesianGrid stroke="#E5E2D6" strokeDasharray="3 3" />
              <XAxis dataKey="run" stroke="#6B6A63" tick={{ fontSize: 12 }} />
              <YAxis stroke="#6B6A63" tick={{ fontSize: 12 }} />
              <Tooltip
                contentStyle={{
                  background: "#FFFFFF",
                  border: "1px solid #E5E2D6",
                  borderRadius: 10,
                  fontSize: 13,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="critical"
                stackId="s"
                stroke="#B5532E"
                fill="#B5532E"
                fillOpacity={0.55}
                name="Critical"
              />
              <Area
                type="monotone"
                dataKey="major"
                stackId="s"
                stroke="#D69258"
                fill="#D69258"
                fillOpacity={0.55}
                name="Major"
              />
              <Area
                type="monotone"
                dataKey="minor"
                stackId="s"
                stroke="#A8A270"
                fill="#A8A270"
                fillOpacity={0.55}
                name="Minor"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function shortLabel(name: string, max = 28): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + "…";
}

function FailureClustersCard({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: ["analytics", "failure-clusters", projectId],
    queryFn: () => api.analytics.failureClusters(projectId),
  });
  const clusters: FailureCluster[] = q.data?.clusters ?? [];
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const data = clusters.slice(0, 10).map((c) => ({
    label: `${c.category} · ${c.tag}`,
    count: c.failure_count,
    severity: c.severity_score,
    avgSev: c.severity_score / Math.max(1, c.failure_count),
  }));
  function colorFor(avgSev: number): string {
    if (avgSev >= 2.5) return "#B5532E";
    if (avgSev >= 1.5) return "#D69258";
    return "#A8A270";
  }
  return (
    <Card>
      <CardTitle>Top Failing Clusters (latest run)</CardTitle>
      <p className="mt-1 font-sans text-[13px] text-text-muted">
        {q.data?.run_name ? `Run: ${q.data.run_name}` : "Failures grouped by category and tag, ranked by severity-weighted count."}
      </p>
      {clusters.length === 0 ? (
        <p className="mt-4 font-sans text-[14px] text-text-muted">No failures in the latest run.</p>
      ) : (
        <>
          <div className="mt-3 h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
              >
                <CartesianGrid stroke="#E5E2D6" strokeDasharray="3 3" />
                <XAxis type="number" stroke="#6B6A63" tick={{ fontSize: 12 }} />
                <YAxis
                  type="category"
                  dataKey="label"
                  stroke="#6B6A63"
                  tick={{ fontSize: 12 }}
                  width={180}
                />
                <Tooltip
                  contentStyle={{
                    background: "#FFFFFF",
                    border: "1px solid #E5E2D6",
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                />
                <Bar dataKey="count" name="Failures">
                  {data.map((d, i) => (
                    <Cell key={i} fill={colorFor(d.avgSev)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-3 flex flex-col gap-1">
            {clusters.map((c) => {
              const key = `${c.category}::${c.tag}`;
              const open = expanded === key;
              return (
                <li key={key} className="rounded-md border border-border bg-surface">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : key)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left"
                  >
                    <span className="font-sans text-[13px] text-text">
                      {c.category} · {c.tag}
                    </span>
                    <span className="font-mono text-[12px] tabular-nums text-text-muted">
                      {c.failure_count} fails · sev {c.severity_score}
                    </span>
                  </button>
                  {open && (
                    <ul className="border-t border-border bg-surface-sunken px-3 py-2">
                      {c.sample_questions.map((s, i) => (
                        <li
                          key={i}
                          className="py-1 font-sans text-[12px] text-text-muted"
                        >
                          • {s.length > 200 ? s.slice(0, 200) + "…" : s}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Regression view
// ---------------------------------------------------------------------------

function RegressionView({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const runNamesQ = useQuery({
    queryKey: ["analytics", "run-names", projectId],
    queryFn: () => api.analytics.runNames(projectId),
  });
  const runNames: RunNameItem[] = runNamesQ.data ?? [];
  const urlBase = searchParams.get("base");
  const urlHead = searchParams.get("head");
  const defaultBase = urlBase ?? runNames[0]?.name ?? "";
  const defaultHead =
    urlHead ?? runNames[runNames.length - 1]?.name ?? "";
  const [base, setBase] = React.useState(defaultBase);
  const [head, setHead] = React.useState(defaultHead);
  React.useEffect(() => {
    if (!base && runNames[0]) setBase(runNames[0].name);
    if (!head && runNames.length > 1) setHead(runNames[runNames.length - 1].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runNames.length]);
  React.useEffect(() => {
    if (urlBase) setBase(urlBase);
    if (urlHead) setHead(urlHead);
  }, [urlBase, urlHead]);

  const [openRow, setOpenRow] = React.useState<
    { row: RegressionItem; kind: "broken" | "fixed" } | null
  >(null);

  const canCompare = base && head && base !== head;
  const regQ = useQuery({
    queryKey: ["analytics", "regression", projectId, base, head],
    queryFn: () =>
      api.analytics.regression({
        projectId,
        base_run_name: base,
        head_run_name: head,
      }),
    enabled: !!canCompare,
  });

  if (runNamesQ.isLoading) {
    return <p className="font-sans text-[14px] text-text-muted">Loading…</p>;
  }
  if (runNames.length < 2) {
    return (
      <Card>
        <p className="font-sans text-[14px] text-text-muted">
          Need at least 2 run-groups to compare.
        </p>
      </Card>
    );
  }

  const data = regQ.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-3">
        <div className="flex flex-col gap-1">
          <span className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
            Compare
          </span>
          <Select
            selectSize="sm"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          >
            {runNames.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        <span className="pb-2 font-sans text-[13px] text-text-muted">→</span>
        <div className="flex flex-col gap-1">
          <span className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
            With
          </span>
          <Select
            selectSize="sm"
            value={head}
            onChange={(e) => setHead(e.target.value)}
          >
            {runNames.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!canCompare ? (
        <p className="font-sans text-[14px] text-text-muted">Pick two different runs to compare.</p>
      ) : regQ.isLoading ? (
        <p className="font-sans text-[14px] text-text-muted">Loading…</p>
      ) : data ? (
        <>
          <SummaryBanner data={data} />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Newly broken" value={String(data.summary.newly_broken_count)} accent="danger" />
            <StatTile label="Newly fixed" value={String(data.summary.newly_fixed_count)} accent="success" />
            <StatTile label="Still failing" value={String(data.summary.still_failing_count)} />
            <StatTile
              label="Net Δ pp"
              value={(data.summary.net_delta_pp >= 0 ? "+" : "") + data.summary.net_delta_pp.toFixed(1)}
              accent={data.summary.net_delta_pp >= 0 ? "success" : "danger"}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RegressionTable
              title="Newly broken"
              borderClass="border-danger"
              rows={data.newly_broken}
              onOpen={(row) => setOpenRow({ row, kind: "broken" })}
            />
            <RegressionTable
              title="Newly fixed"
              borderClass="border-success"
              rows={data.newly_fixed}
              onOpen={(row) => setOpenRow({ row, kind: "fixed" })}
            />
          </div>
          {openRow && (
            <RegressionDiffModal
              row={openRow.row}
              kind={openRow.kind}
              onClose={() => setOpenRow(null)}
            />
          )}
          <Card>
            <CardTitle>Per-dataset Δ pp</CardTitle>
            <p className="mt-1 font-sans text-[13px] text-text-muted">
              Pass-rate change (percentage points) per dataset.
            </p>
            <div className="mt-3 h-[260px]">
              {data.per_dataset.length === 0 ? (
                <EmptyChart />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.per_dataset.map((d) => ({
                      ds: shortLabel(d.dataset_name, 22),
                      delta: d.delta_pp,
                    }))}
                    margin={{ top: 8, right: 16, bottom: 30, left: 0 }}
                  >
                    <CartesianGrid stroke="#E5E2D6" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="ds"
                      stroke="#6B6A63"
                      tick={{ fontSize: 11 }}
                      angle={-15}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis stroke="#6B6A63" tick={{ fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        background: "#FFFFFF",
                        border: "1px solid #E5E2D6",
                        borderRadius: 10,
                        fontSize: 13,
                      }}
                    />
                    <Bar dataKey="delta" name="Δ pp">
                      {data.per_dataset.map((d, i) => (
                        <Cell key={i} fill={d.delta_pp >= 0 ? "#6E8A5C" : "#B5532E"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function SummaryBanner({ data }: { data: RegressionResponse }) {
  const net = data.summary.net_delta_pp;
  const sign = net >= 0 ? "+" : "";
  return (
    <div className="rounded-md border border-accent bg-accent/10 px-4 py-3">
      <span className="font-sans text-[14px] text-text">
        <strong>{data.summary.newly_broken_count}</strong> newly broken,{" "}
        <strong>{data.summary.newly_fixed_count}</strong> newly fixed, net Δ{" "}
        <strong>{sign}{net.toFixed(1)} pp</strong>.
      </span>
    </div>
  );
}

function RegressionTable({
  title,
  borderClass,
  rows,
  onOpen,
}: {
  title: string;
  borderClass: string;
  rows: RegressionItem[];
  onOpen?: (row: RegressionItem) => void;
}) {
  return (
    <Card className={`border-2 ${borderClass}`}>
      <CardTitle>{title}</CardTitle>
      <p className="mt-1 font-sans text-[12px] text-text-muted">
        {rows.length} rows · click a row to compare base vs head
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 font-sans text-[14px] text-text-muted">None.</p>
      ) : (
        <div className="mt-3 max-h-[380px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface-raised">
              <tr>
                <Th align="left">Question</Th>
                <Th align="left">Dataset</Th>
                <Th align="right">Base → Head</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const q = (r.question || "").trim();
                const short = q.length > 80 ? q.slice(0, 80) + "…" : q;
                return (
                  <tr
                    key={i}
                    className="cursor-pointer border-t border-border align-top transition-colors hover:bg-surface-sunken"
                    onClick={() => onOpen?.(r)}
                  >
                    <td
                      className="px-2 py-1.5 font-sans text-[12px] text-text"
                      title={q}
                    >
                      {short}
                      {r.category ? (
                        <span className="ml-1 font-sans text-[10px] uppercase tracking-[0.04em] text-text-subtle">
                          [{r.category}]
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 font-sans text-[12px] text-text-muted">
                      {r.dataset_name}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-[12px] tabular-nums text-text">
                      {fmtScore(r.base_score)} → {fmtScore(r.head_score)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RegressionDiffModal({
  row,
  kind,
  onClose,
}: {
  row: RegressionItem;
  kind: "broken" | "fixed";
  onClose: () => void;
}) {
  const baseQ = useQuery({
    queryKey: ["evaluation", row.eval_id_base],
    queryFn: () => api.evaluations.get(row.eval_id_base as string),
    enabled: Boolean(row.eval_id_base),
  });
  const headQ = useQuery({
    queryKey: ["evaluation", row.eval_id_head],
    queryFn: () => api.evaluations.get(row.eval_id_head as string),
    enabled: Boolean(row.eval_id_head),
  });

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const title =
    kind === "fixed" ? "Newly fixed — base vs head" : "Newly broken — base vs head";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="font-serif text-[20px] leading-7 text-text">{title}</h3>
            <p className="mt-1 truncate font-sans text-[13px] text-text-muted" title={row.question}>
              {row.question}
            </p>
            <p className="mt-0.5 font-sans text-[12px] text-text-subtle">
              {row.dataset_name}
              {row.category ? ` · ${row.category}` : ""}
              {row.severity ? ` · ${row.severity}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 rounded-md border border-border bg-surface-raised px-2 py-1 font-sans text-[12px] text-text-muted hover:bg-surface-sunken"
            aria-label="Close"
          >
            Close ✕
          </button>
        </div>
        <div className="grid grid-cols-1 gap-0 overflow-y-auto md:grid-cols-2">
          <DiffPane title="Base" data={baseQ.data} loading={baseQ.isLoading} score={row.base_score} />
          <div className="border-l border-border">
            <DiffPane title="Head" data={headQ.data} loading={headQ.isLoading} score={row.head_score} />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-3">
          {row.eval_id_base && (
            <a
              href={`/evaluations/${row.eval_id_base}`}
              target="_blank"
              rel="noreferrer"
              className="font-sans text-[13px] text-accent-pressed hover:underline"
            >
              Open base eval ↗
            </a>
          )}
          {row.eval_id_head && (
            <a
              href={`/evaluations/${row.eval_id_head}`}
              target="_blank"
              rel="noreferrer"
              className="font-sans text-[13px] text-accent-pressed hover:underline"
            >
              Open head eval ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffPane({
  title,
  data,
  loading,
  score,
}: {
  title: string;
  data: { chatbot_response: string; rationale: string | null; guideline_findings: { reason: string; severity: string | null }[] } | undefined;
  loading: boolean;
  score: number | null;
}) {
  const scoreCls = score == null ? null : scoreBandClasses(score);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h4 className="font-sans text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          {title}
        </h4>
        {scoreCls && score != null ? (
          <span
            className={`inline-flex h-[24px] items-center rounded-sm px-2 font-mono text-[13px] tabular-nums ${scoreCls.bgClass} ${scoreCls.fgClass}`}
          >
            {score.toFixed(0)}
          </span>
        ) : (
          <span className="font-mono text-[13px] text-text-subtle">—</span>
        )}
      </div>
      {loading ? (
        <p className="font-sans text-[13px] text-text-muted">Loading…</p>
      ) : !data ? (
        <p className="font-sans text-[13px] text-text-muted">No data.</p>
      ) : (
        <>
          <div>
            <p className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
              Chatbot response
            </p>
            <div className="max-h-[260px] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface-sunken px-3 py-2 font-sans text-[13px] leading-[20px] text-text">
              {data.chatbot_response || "—"}
            </div>
          </div>
          {data.rationale && (
            <div>
              <p className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                Rationale
              </p>
              <div className="max-h-[180px] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface-raised px-3 py-2 font-serif text-[13px] leading-[20px] text-text">
                {data.rationale}
              </div>
            </div>
          )}
          {data.guideline_findings.length > 0 && (
            <div>
              <p className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                Findings ({data.guideline_findings.length})
              </p>
              <ul className="flex flex-col gap-1">
                {data.guideline_findings.slice(0, 5).map((f, i) => (
                  <li
                    key={i}
                    className="rounded-md border border-border bg-surface-raised px-2 py-1 font-sans text-[12px] text-text"
                  >
                    <span className="mr-1 font-semibold uppercase tracking-[0.04em] text-text-muted">
                      {f.severity || "—"}
                    </span>
                    {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function fmtScore(s: number | null | undefined): string {
  if (s == null) return "—";
  return s.toFixed(0);
}

// ---------------------------------------------------------------------------
// Tokens view
// ---------------------------------------------------------------------------

function TokensView({ projectId }: { projectId: string }) {
  const summaryQ = useQuery({
    queryKey: ["analytics", "summary", projectId, "tokens"],
    queryFn: () => api.analytics.summary({ project_id: projectId }),
  });
  const topQ = useQuery({
    queryKey: ["analytics", "top-tokens", projectId],
    queryFn: () => api.analytics.topTokenEvaluations(projectId, 10),
  });
  const summary = summaryQ.data;
  const top: TopTokenEvaluation[] = topQ.data ?? [];
  const numberFmt = new Intl.NumberFormat("en-US");
  const fmt = (n: number | undefined | null) =>
    n == null ? "—" : numberFmt.format(n);

  const byRun = summary?.tokens_by_run ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatTile label="Judge" value={fmt(summary?.total_judge_tokens)} />
        <StatTile label="Reference" value={fmt(summary?.total_reference_tokens)} />
        <StatTile label="Chatbot" value={fmt(summary?.total_chatbot_tokens)} />
      </div>

      <Card>
        <CardTitle>Tokens per run</CardTitle>
        <p className="mt-1 font-sans text-[13px] text-text-muted">
          Total tokens consumed per dataset run-group, in time order.
        </p>
        <div className="mt-3 h-[260px]">
          {byRun.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={byRun.map((r) => ({
                  name: shortLabel(r.run_name, 22),
                  total: r.total,
                }))}
                margin={{ top: 8, right: 16, bottom: 30, left: 0 }}
              >
                <CartesianGrid stroke="#E5E2D6" strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  stroke="#6B6A63"
                  tick={{ fontSize: 11 }}
                  angle={-15}
                  textAnchor="end"
                  height={50}
                />
                <YAxis stroke="#6B6A63" tick={{ fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    background: "#FFFFFF",
                    border: "1px solid #E5E2D6",
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                  formatter={(v) => numberFmt.format(Number(v) || 0)}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke={ACCENT}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  name="Total tokens"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>Top 10 token-heavy evaluations</CardTitle>
        <p className="mt-1 font-sans text-[13px] text-text-muted">
          Highest single-evaluation token usage across this project.
        </p>
        {top.length === 0 ? (
          <p className="mt-4 font-sans text-[14px] text-text-muted">No data yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th align="left">Question</Th>
                  <Th align="right">Judge</Th>
                  <Th align="right">Reference</Th>
                  <Th align="right">Chatbot</Th>
                  <Th align="right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {top.map((e) => {
                  const q = (e.question || "").trim();
                  const short = q.length > 120 ? q.slice(0, 120) + "…" : q;
                  return (
                    <tr key={e.id} className="border-t border-border">
                      <td className="px-3 py-2 font-sans text-[13px] text-text" title={q}>
                        <a
                          href={`/evaluations/${e.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-pressed hover:underline"
                        >
                          {short}
                        </a>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[13px] tabular-nums text-text-muted">
                        {numberFmt.format(e.judge_total_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[13px] tabular-nums text-text-muted">
                        {numberFmt.format(e.reference_total_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[13px] tabular-nums text-text-muted">
                        {numberFmt.format(e.chatbot_total_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[13px] tabular-nums text-text">
                        {numberFmt.format(e.total_tokens)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
