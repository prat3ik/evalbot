"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DatasetRunHeatmap } from "@/components/DatasetRunHeatmap";
import {
  API_BASE_URL,
  datasetsApi,
  type DatasetRun,
} from "@/lib/api";

import {
  RunByTagBreakdown,
  RunResultsContent,
  RunSourceIndicator,
  RunSummarySection,
  ViewToggle,
} from "../../_datasets/DatasetsTab";

export const dynamic = "force-dynamic";

export default function RunResultsPage({
  params,
}: {
  params: { id: string; runId: string };
}) {
  const { id: projectId, runId } = params;
  const [view, setView] = React.useState<"heatmap" | "table">("table");

  const q = useQuery<DatasetRun>({
    queryKey: ["dataset-run", runId],
    queryFn: () => datasetsApi.getRun(runId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1500;
      return data.status === "pending" || data.status === "running"
        ? 1500
        : false;
    },
  });

  const downloadUrl = q.data
    ? `${API_BASE_URL}/api/analytics/dataset-report.pdf?dataset_id=${q.data.dataset_id}&run_id=${runId}`
    : null;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          href={`/projects/${projectId}?tab=datasets`}
          className="inline-flex items-center gap-1.5 font-sans text-[13px] text-text-muted hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to datasets
        </Link>
        {downloadUrl && (
          <a href={downloadUrl} target="_blank" rel="noreferrer">
            <Button size="sm" variant="secondary">
              <Download className="h-4 w-4" /> Download dataset PDF
            </Button>
          </a>
        )}
      </div>

      <div>
        <header className="mb-4 border-b border-border pb-3">
          <h1 className="font-serif text-[26px] font-medium leading-9 text-text">
            {q.data?.name || "Run results"}
          </h1>
          {q.data && (
            <p className="mt-1 font-sans text-[13px] text-text-muted">
              {q.data.ai_provider ? `${q.data.ai_provider} · ` : ""}
              {q.data.status} ·{" "}
              {new Date(q.data.started_at).toLocaleString()}
              {q.data.finished_at
                ? ` → ${new Date(q.data.finished_at).toLocaleString()}`
                : ""}{" "}
              · {q.data.total_rows} rows
            </p>
          )}
        </header>

        {q.isLoading || !q.data ? (
          <Card>
            <p className="font-sans text-[14px] text-text-muted">Loading…</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <RunSourceIndicator run={q.data} />
              <div className="print-hide">
                <ViewToggle value={view} onChange={setView} />
              </div>
            </div>
            <RunSummarySection run={q.data} />
            {view === "heatmap" ? (
              <DatasetRunHeatmap runId={runId} />
            ) : (
              <RunResultsContent run={q.data} />
            )}
            <RunByTagBreakdown run={q.data} />
          </div>
        )}
      </div>
    </div>
  );
}
