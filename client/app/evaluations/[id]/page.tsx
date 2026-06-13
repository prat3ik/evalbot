"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EvaluationResultPanel } from "@/components/EvaluationResultPanel";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

const METHOD_LABEL: Record<string, string> = {
  ai: "AI",
};

export default function EvaluationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const detailQ = useQuery({
    queryKey: ["evaluation", id],
    queryFn: () => api.evaluations.get(id as string),
    enabled: Boolean(id),
  });

  const projectId = detailQ.data?.project_id;
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.projects.get(projectId as string),
    enabled: Boolean(projectId),
  });

  if (detailQ.isLoading) {
    return (
      <Card>
        <p className="font-sans text-[14px] text-text-muted">Loading evaluation…</p>
      </Card>
    );
  }
  if (detailQ.isError || !detailQ.data) {
    return (
      <Card>
        <p className="font-sans text-[15px] text-danger">
          {(detailQ.error as Error)?.message ?? "Failed to load evaluation."}
        </p>
        <p className="mt-3 font-sans text-[13px] text-text-muted">
          <Link href="/" className="text-accent-pressed underline">
            Back to projects
          </Link>
        </p>
      </Card>
    );
  }

  const detail = detailQ.data;
  const projectName = projectQ.data?.name ?? "…";
  const methodLabel = METHOD_LABEL[detail.method] ?? detail.method;

  return (
    <>
      <div className="mb-4">
        <Breadcrumbs
          items={[
            { label: "All Projects", href: "/" },
            {
              label: projectName,
              href: `/projects/${detail.project_id}?tab=activity`,
            },
            { label: "Evaluation" },
          ]}
        />
      </div>

      <header className="mb-6">
        <h1 className="font-serif text-[32px] font-medium leading-10 text-text">Evaluation</h1>
        {detail.created_at && (
          <p className="mt-1 font-sans text-[13px] text-text-subtle">
            {relativeTime(detail.created_at)}
          </p>
        )}
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2 font-sans text-[13px]">
        <Badge variant="neutral">Method: {methodLabel}</Badge>
        {detail.ai_provider && <Badge variant="info">Provider: {detail.ai_provider}</Badge>}
        <Link
          href={`/projects/${detail.project_id}`}
          className="inline-flex h-[22px] items-center rounded-sm bg-accent-soft px-2 font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-accent-pressed transition-colors duration-fast ease-ev hover:bg-accent hover:text-accent-fg"
        >
          {projectName}
        </Link>
        {detail.dataset_run_id && (
          <Link
            href={`/projects/${detail.project_id}/runs/${detail.dataset_run_id}`}
            className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-border bg-surface-raised px-2 font-sans text-[12px] text-text hover:bg-surface-sunken"
            title="View the dataset run this evaluation was part of"
          >
            <span className="font-semibold uppercase tracking-[0.04em] text-text-muted">
              Run
            </span>
            <span className="truncate max-w-[260px]">
              {detail.dataset_run_name || detail.dataset_name || "dataset run"}
            </span>
          </Link>
        )}
        {detail.dataset_row_id && detail.dataset_id && (
          <Link
            href={`/projects/${detail.project_id}/datasets/${detail.dataset_id}?row=${detail.dataset_row_id}`}
            className="inline-flex h-[22px] items-center rounded-sm border border-border bg-surface-raised px-2 font-sans text-[12px] text-text hover:bg-surface-sunken"
            title="Open the source dataset row"
          >
            View dataset row
          </Link>
        )}
      </div>

      <QuestionPanel
        question={detail.question}
        turns={detail.turns ?? []}
      />

      <Card>
        <EvaluationResultPanel result={detail} showResponses />
      </Card>
    </>
  );
}

function QuestionPanel({
  question,
  turns,
}: {
  question: string;
  turns: { role: string; content: string }[];
}) {
  const isMultiTurn = Array.isArray(turns) && turns.length > 1;
  const title = isMultiTurn ? "Conversation" : "Question";

  return (
    <Card className="mb-4">
      <div className="font-sans text-[12px] font-semibold uppercase tracking-[0.04em] text-text-muted">
        {title}
      </div>
      {isMultiTurn ? (
        <div className="mt-3 flex flex-col gap-2">
          {turns.map((t, i) => {
            const role = (t.role || "").toLowerCase();
            const isUser = role === "user";
            const isSystem = role === "system";
            const align = isUser ? "items-end" : "items-start";
            const bubbleCls = isSystem
              ? "bg-surface-sunken text-text-muted border border-border"
              : isUser
                ? "bg-accent-soft text-text"
                : "bg-surface-raised text-text border border-border";
            return (
              <div key={i} className={`flex ${align} flex-col`}>
                <span className="mb-0.5 font-sans text-[11px] uppercase tracking-[0.04em] text-text-subtle">
                  {t.role || "turn"}
                </span>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-md px-3 py-2 font-sans text-[14px] leading-[20px] ${bubbleCls}`}
                >
                  {t.content}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap break-words font-sans text-[15px] leading-[22px] text-text">
          {question}
        </p>
      )}
    </Card>
  );
}
