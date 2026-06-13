"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookmarkPlus, Pencil, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { QuestionPicker } from "@/components/ui/QuestionPicker";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { EvaluationResultPanel } from "@/components/EvaluationResultPanel";
import { SaveToDatasetDialog } from "@/components/SaveToDatasetDialog";
import { cn } from "@/lib/cn";
import {
  ApiError,
  api,
  chatbotEndpointsApi,
  type AiProvider,
  type ChatbotEndpointTestResult,
  type EvaluationMethod,
  type EvaluationRequest,
  type EvaluationResult,
  type Project,
  type Question,
} from "@/lib/api";

type QuestionMode = "predefined" | "custom";
type ResponseSource = "manual" | "endpoint";

const PROVIDER_OPTIONS: { label: string; value: AiProvider }[] = [
  { label: "Claude", value: "anthropic" },
  { label: "Gemini", value: "gemini" },
  { label: "OpenAI", value: "openai" },
  { label: "Ollama", value: "ollama" },
];

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function SingleTurnTab({ project }: { project: Project }) {
  const projectId = project.id;
  const [questionMode, setQuestionMode] = React.useState<QuestionMode>("predefined");
  const [predefinedId, setPredefinedId] = React.useState<string>("");
  const [customQuestion, setCustomQuestion] = React.useState<string>("");
  const [chatbotResponse, setChatbotResponse] = React.useState<string>("");
  const [responseSource, setResponseSource] = React.useState<ResponseSource>("manual");
  const [selectedEndpointId, setSelectedEndpointId] = React.useState<string>("");
  const [fetchedResponse, setFetchedResponse] = React.useState<string>("");
  const [fetchedResult, setFetchedResult] =
    React.useState<ChatbotEndpointTestResult | null>(null);
  const [editingFetched, setEditingFetched] = React.useState<boolean>(false);
  const [referenceOverride, setReferenceOverride] = React.useState<string>("");
  const [editingReference, setEditingReference] = React.useState<boolean>(false);
  const method: EvaluationMethod = "ai";
  const [provider, setProvider] = React.useState<AiProvider>("anthropic");
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);

  const endpointsQ = useQuery({
    queryKey: ["chatbot-endpoints", projectId],
    queryFn: () => chatbotEndpointsApi.list(projectId),
  });

  // Pick the project's default endpoint on first load.
  React.useEffect(() => {
    if (!endpointsQ.data || selectedEndpointId) return;
    const def = endpointsQ.data.find((e) => e.is_default) ?? endpointsQ.data[0];
    if (def) setSelectedEndpointId(def.id);
  }, [endpointsQ.data, selectedEndpointId]);

  const questionsQ = useQuery({
    queryKey: ["questions", projectId],
    queryFn: () => api.questions.list({ projectId }),
    enabled: questionMode === "predefined",
  });

  const idQuestions: (Question & { id: string })[] = React.useMemo(() => {
    return (questionsQ.data ?? []).filter(
      (q): q is Question & { id: string } => typeof q.id === "string",
    );
  }, [questionsQ.data]);

  const selectedQuestion: string = React.useMemo(() => {
    if (questionMode === "custom") return customQuestion.trim();
    const found = idQuestions.find((q) => q.id === predefinedId);
    return found?.text ?? "";
  }, [questionMode, customQuestion, predefinedId, idQuestions]);

  const debouncedQuestion = useDebounced(selectedQuestion, 500);

  const referenceQ = useQuery({
    queryKey: ["reference", projectId, debouncedQuestion, provider],
    queryFn: () =>
      api.reference.generate(projectId, {
        question: debouncedQuestion,
        provider,
      }),
    enabled: debouncedQuestion.length > 0,
  });

  const referenceText: string = editingReference
    ? referenceOverride
    : referenceOverride || referenceQ.data?.answer || "";

  const evalMut = useMutation<EvaluationResult, Error, EvaluationRequest>({
    mutationFn: (body) => api.evaluate.run(body),
  });

  const fetchMut = useMutation<ChatbotEndpointTestResult, Error, void>({
    mutationFn: async () => {
      if (!selectedEndpointId) throw new Error("Pick an endpoint first.");
      if (!selectedQuestion) throw new Error("Select a question first.");
      return chatbotEndpointsApi.test(selectedEndpointId, {
        question: selectedQuestion,
      });
    },
    onSuccess: (r) => {
      setFetchedResult(r);
      setFetchedResponse(r.response_text || "");
      setEditingFetched(false);
    },
  });

  // The effective chatbot response sent to evaluate:
  const effectiveResponse =
    responseSource === "manual" ? chatbotResponse : fetchedResponse;

  function handleReset() {
    setQuestionMode("predefined");
    setPredefinedId("");
    setCustomQuestion("");
    setChatbotResponse("");
    setResponseSource("manual");
    setFetchedResponse("");
    setFetchedResult(null);
    setEditingFetched(false);
    setReferenceOverride("");
    setEditingReference(false);
    setProvider("anthropic");
    evalMut.reset();
    fetchMut.reset();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedQuestion || !effectiveResponse.trim()) return;
    const body: EvaluationRequest = {
      project_id: projectId,
      question: selectedQuestion,
      chatbot_response: effectiveResponse,
      method,
      ai_provider: provider,
      reference_answer: referenceText || null,
    };
    evalMut.mutate(body);
  }

  const hasQuestion = Boolean(selectedQuestion);
  const hasResponse = effectiveResponse.trim().length > 0;
  const awaitingFetch =
    responseSource === "endpoint" && !fetchedResult && !hasResponse;
  const canSubmit = hasQuestion && hasResponse && !evalMut.isPending;

  const disabledHint = !hasQuestion
    ? "Choose or type a test question first."
    : awaitingFetch
      ? "Fetch the response first"
      : !hasResponse
        ? responseSource === "manual"
          ? "Paste the chatbot response before running."
          : "Fetch the response first"
        : null;

  const endpoints = endpointsQ.data ?? [];

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <div className="mb-3 border-b border-border pb-3">
          <CardTitle>Chatbot Evaluation</CardTitle>
          <p className="mt-0.5 font-sans text-[12px] text-text-muted">
            Test a single response against your reference answer.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <SectionLabel>Inputs</SectionLabel>
          <FormField label="Test Question" required>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <TabToggle
                value={questionMode}
                onChange={setQuestionMode}
                options={[
                  { label: "Predefined", value: "predefined" },
                  { label: "Custom", value: "custom" },
                ]}
              />
              {questionMode === "predefined" && (
                <span className="inline-flex items-center gap-1 text-[12px] leading-[16px] text-text-muted">
                </span>
              )}
            </div>
            {questionMode === "predefined" ? (
              <QuestionPicker
                value={predefinedId}
                onChange={setPredefinedId}
                questions={idQuestions}
                loading={questionsQ.isLoading}
              />
            ) : (
              <Textarea
                value={customQuestion}
                onChange={(e) => setCustomQuestion(e.target.value)}
                placeholder="Type a custom test question"
                className="min-h-[72px]"
              />
            )}
          </FormField>

          <FormField label="Chatbot Response" required>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <TabToggle
                value={responseSource}
                onChange={(v) => {
                  setResponseSource(v);
                  if (v === "manual") {
                    setEditingFetched(false);
                  }
                }}
                options={[
                  { label: "Manual paste", value: "manual" },
                  { label: "Fetch from endpoint", value: "endpoint" },
                ]}
              />
            </div>

            {responseSource === "manual" ? (
              <Textarea
                value={chatbotResponse}
                onChange={(e) => setChatbotResponse(e.target.value)}
                placeholder="Paste the response from the chatbot you are testing"
                className="min-h-[88px]"
                required
              />
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedEndpointId}
                    onChange={(e) => {
                      setSelectedEndpointId(e.target.value);
                      setFetchedResult(null);
                      setFetchedResponse("");
                    }}
                    className="flex-1"
                  >
                    <option value="" disabled>
                      {endpointsQ.isLoading
                        ? "Loading endpoints…"
                        : endpoints.length === 0
                          ? "No endpoints configured"
                          : "Select an endpoint"}
                    </option>
                    {endpoints.map((ep) => (
                      <option key={ep.id} value={ep.id}>
                        {ep.name}
                        {ep.is_default ? " (default)" : ""}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={
                      !selectedEndpointId ||
                      !selectedQuestion ||
                      fetchMut.isPending
                    }
                    onClick={() => fetchMut.mutate()}
                  >
                    {fetchMut.isPending ? "Fetching…" : "Fetch response"}
                  </Button>
                </div>

                {endpoints.length === 0 && !endpointsQ.isLoading && (
                  <p className="font-sans text-[12px] text-text-muted">
                    Add an endpoint in the{" "}
                    <span className="font-medium text-text">Configuration</span>{" "}
                    tab to fetch responses directly from your bot.
                  </p>
                )}

                {fetchMut.error instanceof Error && (
                  <p
                    role="alert"
                    className="rounded-md border border-danger bg-danger-soft px-3 py-2 font-sans text-[12px] text-danger"
                  >
                    {fetchMut.error.message}
                  </p>
                )}

                {fetchedResult?.error && (
                  <p
                    role="alert"
                    className="rounded-md border border-danger bg-danger-soft px-3 py-2 font-sans text-[12px] text-danger"
                  >
                    {fetchedResult.error}
                  </p>
                )}

                {fetchedResult && !fetchedResult.error && (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      <TokenChip
                        label="prompt"
                        value={fetchedResult.prompt_tokens}
                      />
                      <TokenChip
                        label="completion"
                        value={fetchedResult.completion_tokens}
                      />
                      <TokenChip
                        label="total"
                        value={fetchedResult.total_tokens}
                      />
                      <TokenChip
                        label="latency"
                        value={fetchedResult.latency_ms}
                        suffix="ms"
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-sans text-[12px] text-text-muted">
                        Fetched response{editingFetched ? " (editing)" : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingFetched((v) => !v)}
                        className="font-sans text-[12px] text-accent-pressed underline"
                      >
                        {editingFetched ? "Done editing" : "Edit response"}
                      </button>
                    </div>
                    {editingFetched ? (
                      <Textarea
                        value={fetchedResponse}
                        onChange={(e) => setFetchedResponse(e.target.value)}
                        className="min-h-[88px]"
                      />
                    ) : (
                      <div className="min-h-[72px] whitespace-pre-wrap rounded-md border border-border bg-surface-sunken px-3 py-2 font-sans text-[13px] leading-[20px] text-text">
                        {fetchedResponse || "(empty)"}
                      </div>
                    )}
                  </>
                )}

                {!fetchedResult && (
                  <div className="min-h-[72px] rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-2 font-sans text-[13px] italic leading-[20px] text-text-subtle">
                    Click <span className="not-italic font-medium">Fetch response</span> to call the endpoint with the selected question.
                  </div>
                )}
              </div>
            )}
          </FormField>

          <FormField label="Expected Answer (Ground Truth)">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[13px] leading-[18px] text-text-muted">
                {referenceQ.isFetching
                  ? "Generating from RAG + guidelines…"
                  : referenceQ.isError
                    ? (() => {
                        const err = referenceQ.error;
                        if (err instanceof ApiError) {
                          const body = err.body as { detail?: string } | null;
                          const detail = body?.detail ?? err.message;
                          return `Could not generate reference: ${detail}`;
                        }
                        return "Could not generate reference. You can paste a reference manually via Edit.";
                      })()
                    : referenceText
                      ? "Auto-generated from your documents"
                      : "Pick a question to generate"}
              </div>
              <div className="flex items-center gap-0.5">
                <IconButton
                  title="Regenerate reference"
                  onClick={() => {
                    setReferenceOverride("");
                    setEditingReference(false);
                    referenceQ.refetch();
                  }}
                  disabled={!debouncedQuestion}
                >
                  <RefreshCw size={14} aria-hidden />
                </IconButton>
                <IconButton
                  title={editingReference ? "Done editing" : "Edit reference"}
                  active={editingReference}
                  onClick={() => {
                    if (!editingReference) {
                      setReferenceOverride(referenceOverride || referenceQ.data?.answer || "");
                    }
                    setEditingReference((v) => !v);
                  }}
                >
                  <Pencil size={14} aria-hidden />
                </IconButton>
              </div>
            </div>
            {editingReference ? (
              <Textarea
                value={referenceOverride}
                onChange={(e) => setReferenceOverride(e.target.value)}
                placeholder="Edit the reference answer used for evaluation"
                className="min-h-[96px]"
              />
            ) : (
              <div
                className={cn(
                  "min-h-[72px] rounded-md border border-border bg-surface-sunken",
                  "px-3 py-2 font-sans text-[13px] leading-[20px]",
                  referenceText ? "text-text" : "italic text-text-subtle",
                )}
              >
                {referenceQ.isFetching && !referenceText
                  ? "Generating…"
                  : referenceText || "Reference will appear here once a question is selected."}
              </div>
            )}
          </FormField>

          <SectionLabel>Settings</SectionLabel>
          <FormField label="Judge AI Provider">
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value as AiProvider)}
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
            <p className="mt-1 font-sans text-[12px] leading-[16px] text-text-muted">
              The LLM that grades the chatbot&rsquo;s response. Use a different
              provider for the chatbot endpoint.
            </p>
          </FormField>

          <div className="bg-surface/95 sticky bottom-0 -mx-4 -mb-4 mt-1 flex items-center justify-between gap-3 rounded-b-lg border-t border-border px-4 py-3 backdrop-blur">
            <div className="min-w-0">
              {!canSubmit && !evalMut.isPending && disabledHint && (
                <p className="truncate font-sans text-[12px] text-text-muted">{disabledHint}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={handleReset}>
                Reset
              </Button>
              <Button type="submit" variant="primary" size="md" disabled={!canSubmit}>
                {evalMut.isPending ? "Running…" : "Run Evaluation"}
              </Button>
            </div>
          </div>
        </form>
      </Card>

      <Card className="p-4 lg:sticky lg:top-4">
        <div className="mb-3 flex items-start justify-between gap-3 border-b border-border pb-3">
          <div>
            <CardTitle>Evaluation Results</CardTitle>
            <p className="mt-0.5 font-sans text-[12px] text-text-muted">
              Scores and rationale appear here after you run an evaluation.
            </p>
          </div>
          {evalMut.data && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setSaveDialogOpen(true)}
                title="Save this result to a dataset for batch re-evaluation"
              >
                <BookmarkPlus className="h-4 w-4" />
                Save to dataset
              </Button>
            </div>
          )}
        </div>

        {evalMut.isPending ? (
          <ResultsSkeleton />
        ) : evalMut.isError ? (
          <ErrorState error={evalMut.error} />
        ) : evalMut.data ? (
          <ResultsView result={evalMut.data} />
        ) : (
          <EmptyState />
        )}
      </Card>

      {evalMut.data && (
        <SaveToDatasetDialog
          projectId={projectId}
          open={saveDialogOpen}
          onClose={() => setSaveDialogOpen(false)}
          defaultValues={{
            question: evalMut.data.question,
            expected_response: evalMut.data.reference_answer ?? "",
            chatbot_response: evalMut.data.chatbot_response,
            tags: [],
          }}
        />
      )}
    </div>
  );
}

function TokenChip({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | null;
  suffix?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-sunken px-2 py-0.5 font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
      <span>{label}</span>
      <span className="font-mono text-[11px] tabular-nums normal-case text-text">
        {value == null ? "—" : `${value}${suffix ?? ""}`}
      </span>
    </span>
  );
}

/* ---------- Form primitives ---------- */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mb-2">
      <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
        {children}
      </span>
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md",
        "transition-colors duration-fast ease-ev",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-accent-soft text-accent-pressed"
          : "text-text-muted hover:bg-surface-sunken hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <label className="mb-1.5 font-sans text-[13px] font-medium uppercase leading-[18px] tracking-[0.04em] text-text-muted">
        {label}
        {required && <span className="ml-1 text-accent">*</span>}
      </label>
      {children}
    </div>
  );
}

function TabToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { label: string; value: T }[];
}) {
  return (
    <div
      role="tablist"
      className="inline-flex rounded-md border border-border bg-surface-sunken p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          type="button"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "h-7 rounded-[6px] px-3 font-sans text-[13px] font-medium",
            "transition-colors duration-fast ease-ev",
            value === opt.value
              ? "bg-surface-raised text-text shadow-elev-1"
              : "text-text-muted hover:text-text",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { label: string; value: T }[];
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-sunken p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "h-8 rounded-[6px] px-4 font-sans text-[14px] font-medium",
            "transition-colors duration-fast ease-ev",
            value === opt.value ? "bg-text text-bg" : "text-text-muted hover:text-text",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Results ---------- */

function EmptyState() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3">
        {["Score"].map((label) => (
          <div
            key={label}
            className="bg-surface-sunken/40 flex h-[120px] flex-col justify-between rounded-xl border border-dashed border-border px-3 py-3"
          >
            <div className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-subtle">
              {label}
            </div>
            <div className="font-mono text-[28px] tabular-nums leading-[34px] text-text-subtle">
              —
            </div>
          </div>
        ))}
      </div>
      <div className="bg-surface-sunken/30 rounded-md border border-dashed border-border px-4 py-6 text-center">
        <p className="mx-auto max-w-[40ch] font-serif text-[15px] leading-[24px] text-text-muted">
          Pick a question, paste a response, and click{" "}
          <span className="font-medium text-text">Run Evaluation</span> to see scores and rationale
          here.
        </p>
      </div>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="grid grid-cols-1 gap-3">
        {[0].map((i) => (
          <div key={i} className="h-[140px] rounded-xl border border-border bg-surface-sunken" />
        ))}
      </div>
      <div className="mt-6 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-4 rounded-full bg-surface-sunken" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ error }: { error: Error }) {
  const detail =
    error instanceof ApiError &&
    typeof error.body === "object" &&
    error.body !== null &&
    "detail" in error.body
      ? ` — ${String((error.body as { detail: unknown }).detail)}`
      : "";
  return (
    <div
      role="alert"
      className="rounded-md border border-danger bg-danger-soft px-4 py-3 font-sans text-[14px] leading-[22px] text-danger"
    >
      <div className="mb-1 font-semibold">Evaluation failed</div>
      <div>
        {error.message}
        {detail}
      </div>
    </div>
  );
}

function ResultsView({ result }: { result: EvaluationResult }) {
  return (
    <div className="flex flex-col gap-4">
      {result.question && (
        <section className="rounded-md border border-border bg-surface-sunken/40 px-3 py-2">
          <div className="font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
            Question
          </div>
          <p className="mt-1 whitespace-pre-wrap font-serif text-[15px] leading-[22px] text-text">
            {result.question}
          </p>
        </section>
      )}
      <EvaluationResultPanel result={result} showResponses />
    </div>
  );
}
