"use client";

import * as React from "react";
import { AlertOctagon, ChevronDown, ChevronRight } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { MetricBar } from "@/components/ui/MetricBar";
import { ScoreTile } from "@/components/ui/ScoreTile";
import {
  api,
  // CUSTOM_CHECKS_DISABLED — uncomment to re-enable
  // type CustomCheckResult,
  type EvaluationResult,
  type FindingSeverity,
  type GuidelineFindingOut,
  type MetricScoreOut,
  type PIIHit,
  type PIIKind,
  type RetrievedChunk,
} from "@/lib/api";
import { renderHighlighted } from "@/lib/highlight";
import { DIMENSION_THRESHOLDS, passesThreshold } from "@/lib/thresholds";

const SEVERITY_VARIANT: Record<FindingSeverity, BadgeVariant> = {
  minor: "warn",
  major: "warn",
  critical: "danger",
};

function normaliseSeverity(s: FindingSeverity | string | null): FindingSeverity {
  if (s === "minor" || s === "major" || s === "critical") return s;
  return "minor";
}


export interface EvaluationResultPanelProps {
  result: EvaluationResult;
  /** Show the chatbot response and reference answer side-by-side. By default
   * they render at the top of the panel; set `responsesPlacement="bottom"`
   * to keep the previous layout. */
  showResponses?: boolean;
  responsesPlacement?: "top" | "bottom";
}

export function EvaluationResultPanel({
  result,
  showResponses = false,
  responsesPlacement = "top",
}: EvaluationResultPanelProps) {
  const dims = result.ai_dimensions ?? null;
  const rawScore = result.ai_score ?? result.combined_score ?? 0;
  const piiHits = result.pii_hits ?? [];
  const hasPII = piiHits.length > 0;

  const overrideVerdict = (result.override_verdict ?? null) as "pass" | "fail" | null;
  const hasOverride = overrideVerdict === "pass" || overrideVerdict === "fail";
  const passScore = hasOverride
    ? overrideVerdict === "pass"
    : passesThreshold("combined", rawScore);
  // When overridden, force the tile colour to pass-green/fail-red by pushing
  // the displayed score to a sentinel in the corresponding band.
  const score = hasOverride ? (overrideVerdict === "pass" ? 100 : 0) : rawScore;

  const responsesBlock = showResponses ? (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Subsection title="Chatbot Response">
        <div className="min-h-[80px] whitespace-pre-wrap rounded-md border border-border bg-surface-sunken px-3 py-2 font-sans text-[14px] leading-[22px] text-text">
          {result.chatbot_response
            ? hasPII
              ? renderHighlighted(result.chatbot_response, piiHits)
              : result.chatbot_response
            : "—"}
        </div>
      </Subsection>
      <Subsection title="Reference Answer">
        <div className="min-h-[80px] whitespace-pre-wrap rounded-md border border-border bg-surface-sunken px-3 py-2 font-sans text-[14px] leading-[22px] text-text">
          {result.reference_answer || "—"}
        </div>
      </Subsection>
    </div>
  ) : null;

  const rationaleBlock = result.rationale ? (
    <Subsection title="Rationale">
      <p className="whitespace-pre-wrap font-serif text-[16px] leading-[26px] text-text">
        {result.rationale}
      </p>
    </Subsection>
  ) : null;

  const guidelineBlock = result.guideline_findings.length > 0 ? (
    <Subsection title="Guideline Compliance">
      <ul className="flex flex-col gap-3">
        {result.guideline_findings.map((f, i) => (
          <GuidelineFindingRow key={i} finding={f} />
        ))}
      </ul>
    </Subsection>
  ) : null;

  const scoreCards = (
    <div className="grid grid-cols-1 gap-2">
      {hasOverride && (
        <div className="flex items-center gap-2">
          <Badge variant={overrideVerdict === "pass" ? "success" : "danger"}>
            OVERRIDDEN
          </Badge>
          <span className="font-sans text-[12px] text-text-muted">
            Manually marked {overrideVerdict === "pass" ? "PASS" : "FAIL"} by{" "}
            {result.override_author || "demo-user"}
          </span>
        </div>
      )}
      <ScoreTile
        label={hasOverride ? "Override" : "Score"}
        value={score}
        size="lg"
        primary
        pass={passScore}
      />
    </div>
  );

  const overrideBlock = (
    <OverrideCard result={result} />
  );

  return (
    <div className="flex flex-col gap-6">
      {result.refusal_mode && (
        <div className="flex items-center">
          <span
            title="Scored on refusal intent match instead of text overlap, because both the chatbot and the reference are refusals."
          >
            <Badge variant="info">REFUSAL MODE</Badge>
          </span>
        </div>
      )}

      {hasPII && <PIIBanner hits={piiHits} />}

      {responsesPlacement === "top" && (
        <>
          {scoreCards}
          {responsesBlock}
          {rationaleBlock}
          {overrideBlock}
          {guidelineBlock}
        </>
      )}

      {responsesPlacement === "bottom" && scoreCards}
      {responsesPlacement === "bottom" && overrideBlock}

      {dims && (
        <Subsection title="Detailed Metrics">
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <MetricBar
              label="Similarity"
              value={dims.similarity}
              pass={dims.similarity >= DIMENSION_THRESHOLDS.similarity}
            />
            <MetricBar
              label="Completeness"
              value={dims.completeness}
              pass={dims.completeness >= DIMENSION_THRESHOLDS.completeness}
            />
            <MetricBar
              label="Accuracy"
              value={dims.accuracy}
              pass={dims.accuracy >= DIMENSION_THRESHOLDS.accuracy}
            />
            <MetricBar
              label="Relevance"
              value={dims.relevance}
              pass={dims.relevance >= DIMENSION_THRESHOLDS.relevance}
            />
          </div>
        </Subsection>
      )}

      {result.ai_metrics.length > 0 && (
        <Subsection title="AI Details" hint="model-evaluated">
          <MetricTable rows={result.ai_metrics} />
        </Subsection>
      )}

      {/* CUSTOM_CHECKS_DISABLED — uncomment to re-enable */}
      {/*
      {(result.custom_check_results ?? []).length > 0 && (
        <Subsection title="Custom Checks" hint="plain-English rules">
          <ul className="flex flex-col gap-2">
            {(result.custom_check_results ?? []).map((c) => (
              <CustomCheckRow key={c.id} check={c} />
            ))}
          </ul>
        </Subsection>
      )}
      */}

      {responsesPlacement === "bottom" && guidelineBlock}

      {result.retrieved_chunks.length > 0 && (
        <Subsection title="Retrieved Context">
          <RetrievedContextList chunks={result.retrieved_chunks} />
        </Subsection>
      )}

      <TokenUsageRow result={result} />

      {responsesPlacement === "bottom" && (
        <>
          {rationaleBlock}
          {responsesBlock}
        </>
      )}
    </div>
  );
}

function Subsection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h4 className="font-sans text-[15px] font-semibold leading-[22px] text-text">{title}</h4>
        {hint && (
          <span className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-subtle">
            {hint}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function MetricTable({
  rows,
  highlightPII = false,
}: {
  rows: MetricScoreOut[];
  highlightPII?: boolean;
}) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-border">
          <th className="py-1.5 text-left font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
            Metric
          </th>
          <th className="py-1.5 text-right font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
            Weight
          </th>
          <th className="py-1.5 text-right font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const isPII = row.metric_name === "pii_leakage";
          return (
            <tr
              key={`${row.metric_name}-${i}`}
              className={`border-b border-border last:border-0 ${
                isPII && highlightPII ? "bg-danger-soft" : ""
              }`}
            >
              <td
                className={`py-1.5 font-sans text-[14px] leading-[22px] ${
                  isPII ? "font-semibold text-danger" : "text-text"
                }`}
              >
                {isPII ? "PII" : row.metric_name}
              </td>
              <td
                className={`py-1.5 text-right font-mono text-[14px] tabular-nums leading-5 ${
                  isPII ? "text-danger" : "text-text-muted"
                }`}
              >
                {(row.weight * 100).toFixed(0)}%
              </td>
              <td
                className={`py-1.5 text-right font-mono text-[14px] tabular-nums leading-5 ${
                  isPII ? "text-danger" : "text-text"
                }`}
              >
                {row.value.toFixed(1)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PIIBanner({ hits }: { hits: PIIHit[] }) {
  const counts = hits.reduce<Record<PIIKind, number>>(
    (acc, h) => {
      acc[h.kind] = (acc[h.kind] ?? 0) + 1;
      return acc;
    },
    { email: 0, phone: 0, ssn: 0, cc: 0 },
  );
  const KIND_LABEL: Record<PIIKind, [string, string]> = {
    email: ["email", "emails"],
    phone: ["phone number", "phone numbers"],
    ssn: ["SSN", "SSNs"],
    cc: ["card number", "card numbers"],
  };
  const summary =
    (Object.entries(counts) as [PIIKind, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${KIND_LABEL[k][n === 1 ? 0 : 1]}`)
      .join(", ") || "—";
  return (
    <div
      role="alert"
      className="sticky top-0 z-10 flex items-start gap-3 rounded-lg border border-danger bg-danger-soft p-4"
    >
      <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-danger" strokeWidth={1.75} />
      <div className="flex flex-col gap-0.5">
        <div className="font-sans text-[15px] font-semibold leading-[22px] text-danger">
          PII Leak Detected — evaluation failed
        </div>
        <div className="font-sans text-[13px] leading-[18px] text-danger">
          Detected: {summary}
        </div>
      </div>
    </div>
  );
}

// CUSTOM_CHECKS_DISABLED — uncomment to re-enable
// function CustomCheckRow({ check }: { check: CustomCheckResult }) {
//   return (
//     <li className="rounded-md border border-border bg-surface-raised p-3">
//       <div className="mb-1.5 flex items-center gap-2">
//         <Badge variant={check.passed ? "success" : "danger"}>
//           {check.passed ? "Pass" : "Fail"}
//         </Badge>
//         <span className="flex-1 font-sans text-[14px] leading-[22px] text-text">
//           {check.description || check.id}
//         </span>
//         <span className="font-mono text-[14px] tabular-nums text-text">
//           {check.score.toFixed(0)}%
//         </span>
//       </div>
//       {check.reason && (
//         <p className="font-serif text-[14px] italic leading-[22px] text-text-muted">
//           {check.reason}
//         </p>
//       )}
//     </li>
//   );
// }

function GuidelineFindingRow({ finding }: { finding: GuidelineFindingOut }) {
  const severity = normaliseSeverity(finding.severity);
  return (
    <li className="rounded-md border border-border bg-surface-raised p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge variant={SEVERITY_VARIANT[severity]}>{severity}</Badge>
        <span className="font-sans text-[13px] leading-[18px] text-text-muted">
          {finding.guideline_excerpt}
        </span>
      </div>
      <div className="rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-[13px] leading-[20px] text-text">
        &ldquo;{finding.offending_span}&rdquo;
      </div>
      <p className="mt-2 font-sans text-[14px] leading-[22px] text-text">{finding.reason}</p>
    </li>
  );
}

function RetrievedContextList({ chunks }: { chunks: RetrievedChunk[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {chunks.map((c, i) => (
        <RetrievedContextItem key={i} chunk={c} />
      ))}
    </ul>
  );
}

function RetrievedContextItem({ chunk }: { chunk: RetrievedChunk }) {
  const [open, setOpen] = React.useState(false);
  const sourceLabel = chunk.source ?? chunk.filename ?? "(unknown source)";
  const preview = chunk.text.slice(0, 300);
  return (
    <li className="rounded-md border border-border bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-text-muted" />
        ) : (
          <ChevronRight className="h-4 w-4 text-text-muted" />
        )}
        <span className="font-mono text-[13px] leading-5 text-text-muted">{sourceLabel}</span>
        {typeof chunk.score === "number" && (
          <span className="ml-auto font-mono text-[13px] tabular-nums text-text-subtle">
            {chunk.score.toFixed(2)}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <div className="whitespace-pre-wrap rounded-md border border-border bg-surface-sunken px-3 py-2 font-sans text-[14px] leading-[22px] text-text">
            {preview}
            {chunk.text.length > 300 ? "…" : ""}
          </div>
        </div>
      )}
    </li>
  );
}

const _numberFmt = new Intl.NumberFormat("en-US");

function _fmtTokens(n: number | null | undefined): string {
  return _numberFmt.format(Math.max(0, Math.round(Number(n ?? 0))));
}

function TokenUsageRow({ result }: { result: EvaluationResult }) {
  const judgeTotal = result.judge_total_tokens ?? 0;
  const refTotal = result.reference_total_tokens ?? 0;
  const cbTotal = result.chatbot_total_tokens ?? 0;
  if (!judgeTotal && !refTotal && !cbTotal) return null;

  const items: { label: string; prompt: number; completion: number; total: number }[] = [
    {
      label: "Judge",
      prompt: result.judge_prompt_tokens ?? 0,
      completion: result.judge_completion_tokens ?? 0,
      total: judgeTotal,
    },
    {
      label: "Reference",
      prompt: result.reference_prompt_tokens ?? 0,
      completion: result.reference_completion_tokens ?? 0,
      total: refTotal,
    },
    {
      label: "Chatbot",
      prompt: result.chatbot_prompt_tokens ?? 0,
      completion: result.chatbot_completion_tokens ?? 0,
      total: cbTotal,
    },
  ];

  return (
    <section>
      <div className="mb-2">
        <h4 className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
          Token usage
        </h4>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {items.map((it) => (
          <div
            key={it.label}
            title={`prompt ${_fmtTokens(it.prompt)} → completion ${_fmtTokens(
              it.completion,
            )} → total ${_fmtTokens(it.total)}`}
            className="rounded-md border border-border bg-surface-raised px-3 py-2"
          >
            <div className="font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
              {it.label}
            </div>
            <div className="font-mono text-[16px] tabular-nums leading-5 text-text">
              {_fmtTokens(it.total)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function OverrideCard({ result }: { result: EvaluationResult }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [verdict, setVerdict] = React.useState<"pass" | "fail">("pass");
  const [note, setNote] = React.useState("");
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const overrideVerdict = (result.override_verdict ?? null) as "pass" | "fail" | null;
  const hasOverride = overrideVerdict === "pass" || overrideVerdict === "fail";

  // AI-derived verdict (for display before any override applies).
  const rawScore = result.ai_score ?? result.combined_score ?? 0;
  const aiPass = rawScore >= 75;

  const setMut = useMutation({
    mutationFn: (input: { verdict: "pass" | "fail" | null; note: string }) =>
      api.evaluations.setOverride(result.id, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(["evaluation", result.id], updated);
      queryClient.invalidateQueries({ queryKey: ["evaluations"] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      setOpen(false);
      setSubmitError(null);
      setNote("");
    },
    onError: (err: Error) => {
      setSubmitError(err.message ?? "Failed to save override.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (note.trim().length < 10) {
      setSubmitError("Note must be at least 10 characters.");
      return;
    }
    setMut.mutate({ verdict, note: note.trim() });
  };

  const handleClear = () => {
    if (!window.confirm("Clear this manual override? The AI verdict will be restored.")) return;
    setMut.mutate({ verdict: null, note: "" });
  };

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h4 className="font-sans text-[15px] font-semibold leading-[22px] text-text">
          Reviewer Override
        </h4>
      </div>
      <div className="rounded-md border border-border bg-surface-raised p-3">
        {hasOverride ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={overrideVerdict === "pass" ? "success" : "danger"}>
                {overrideVerdict === "pass" ? "PASS" : "FAIL"} — manually overridden
                {result.override_author ? ` by ${result.override_author}` : ""}
              </Badge>
              {result.override_created_at && (
                <span className="font-sans text-[11px] text-text-subtle">
                  {result.override_created_at}
                </span>
              )}
            </div>
            {result.override_note && (
              <p className="whitespace-pre-wrap rounded-md border border-border bg-surface-sunken px-3 py-2 font-serif text-[14px] leading-[22px] text-text">
                {result.override_note}
              </p>
            )}
            <div>
              <button
                type="button"
                onClick={handleClear}
                disabled={setMut.isPending}
                className="inline-flex h-[26px] items-center rounded-sm border border-border bg-surface px-2 font-sans text-[12px] text-text hover:bg-surface-sunken disabled:opacity-50"
              >
                {setMut.isPending ? "Clearing…" : "Clear override"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Badge variant={aiPass ? "success" : "danger"}>
              AI verdict: {aiPass ? "PASS" : "FAIL"}
            </Badge>
            <span className="font-sans text-[13px] text-text-muted">
              The AI judge classified this as {aiPass ? "passing" : "failing"}.
            </span>
            <button
              type="button"
              onClick={() => {
                setVerdict(aiPass ? "fail" : "pass");
                setNote("");
                setSubmitError(null);
                setOpen(true);
              }}
              className="ml-auto inline-flex h-[26px] items-center rounded-sm border border-accent bg-accent px-2 font-sans text-[12px] font-medium text-white hover:bg-accent/90"
            >
              Override verdict
            </button>
          </div>
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
        >
          <form
            onSubmit={handleSubmit}
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-[520px] flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xl"
          >
            <h3 className="font-serif text-[18px] leading-6 text-text">Override verdict</h3>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 font-sans text-[14px] text-text">
                <input
                  type="radio"
                  name="verdict"
                  value="pass"
                  checked={verdict === "pass"}
                  onChange={() => setVerdict("pass")}
                />
                Pass
              </label>
              <label className="flex items-center gap-2 font-sans text-[14px] text-text">
                <input
                  type="radio"
                  name="verdict"
                  value="fail"
                  checked={verdict === "fail"}
                  onChange={() => setVerdict("fail")}
                />
                Fail
              </label>
            </div>
            <label className="flex flex-col gap-1 font-sans text-[12px] text-text-muted">
              Note (required, min 10 chars)
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-border bg-surface-sunken px-3 py-2 font-sans text-[14px] leading-[20px] text-text"
                placeholder="e.g. support@alphabin.com is a documented public contact, not PII"
              />
            </label>
            {submitError && (
              <p className="font-sans text-[12px] text-danger">{submitError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-[28px] items-center rounded-sm border border-border bg-surface px-3 font-sans text-[12px] text-text hover:bg-surface-sunken"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={setMut.isPending || note.trim().length < 10}
                className="inline-flex h-[28px] items-center rounded-sm border border-accent bg-accent px-3 font-sans text-[12px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {setMut.isPending ? "Saving…" : "Save override"}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
