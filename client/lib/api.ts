/**
 * Typed fetch wrapper for the EvalBot FastAPI backend.
 *
 * Casing convention: snake_case is preserved end-to-end. The backend (FastAPI /
 * Pydantic / SQLModel) emits snake_case JSON and these TS interfaces mirror that
 * exactly. We deliberately avoid a keysToCamel transformer so the wire shape,
 * the DB shape, and the TS shape stay identical — easier to grep, zero runtime
 * cost, and no risk of a bad transform silently dropping a field. Method-level
 * input options use camelCase for ergonomics and are translated to snake_case
 * query params / body fields inline.
 */

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:8000";

// ---------------------------------------------------------------------------
// Error + fetch primitives
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  public readonly status: number;
  // Raw decoded response body. Typed as `unknown` — this is the one place
  // free-form data legitimately leaks in.
  public readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, API_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, headers, ...rest } = options;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;

  const res = await fetch(buildUrl(path, query), {
    ...rest,
    headers: {
      Accept: "application/json",
      ...(isFormData || body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get("content-type") ?? "";
  let payload: unknown = null;
  if (contentType.includes("application/json")) {
    payload = await res.json().catch(() => null);
  } else {
    const text = await res.text().catch(() => "");
    payload = text === "" ? null : text;
  }

  if (!res.ok) {
    // Log the response body so devs see FastAPI's `{detail: ...}` in the
    // console when a request fails.
    // eslint-disable-next-line no-console
    console.error(`[api] ${rest.method ?? "GET"} ${path} -> ${res.status}`, payload);
    throw new ApiError(`Request failed: ${res.status} ${res.statusText}`, res.status, payload);
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// SSE streaming primitive (used by document URL ingest)
// ---------------------------------------------------------------------------

export interface IngestUrlPageEvent {
  type: "page";
  index: number;
  total: number;
  url: string;
  title?: string;
  status: "indexed" | "fetched" | "skipped" | "failed";
  chunks?: number;
  reason?: string;
  error?: string;
  distilled?: boolean;
}

export interface IngestUrlPageProgressEvent {
  type: "page_progress";
  index: number;
  total: number;
  url: string;
  title?: string;
  stage: "distilling";
}

export interface IngestUrlPlanEvent {
  type: "plan";
  files: {
    title: string;
    slug: string;
    description?: string;
    page_indices: number[];
  }[];
  pages_seen: number;
}

export interface IngestUrlFileProgressEvent {
  type: "file_progress";
  slug: string;
  title: string;
  stage: "writing";
}

export interface IngestUrlFileEvent {
  type: "file";
  slug: string;
  title: string;
  description?: string;
  status: "saved" | "skipped" | "failed";
  chunks?: number;
  page_indices?: number[];
  source_urls?: string[];
  reason?: string;
  error?: string;
}

export interface IngestUrlStatusEvent {
  type: "status";
  message: string;
}

export interface IngestUrlDoneEvent {
  type: "done";
  pages_indexed: number;
  pages_seen: number;
  files_saved?: number;
  chunks: number;
}

export interface IngestUrlErrorEvent {
  type: "error";
  message: string;
}

export type IngestUrlEvent =
  | IngestUrlPageEvent
  | IngestUrlPageProgressEvent
  | IngestUrlPlanEvent
  | IngestUrlFileProgressEvent
  | IngestUrlFileEvent
  | IngestUrlStatusEvent
  | IngestUrlDoneEvent
  | IngestUrlErrorEvent;

export interface BuildGuidelinesFileEvent {
  type: "file";
  filename: string;
  guideline_id?: string;
  title: string;
  status: "saved" | "skipped" | "failed";
  size?: number;
  reason?: string;
  error?: string;
}

export interface BuildGuidelinesStatusEvent {
  type: "status";
  message: string;
}

export interface BuildGuidelinesDoneEvent {
  type: "done";
  files_saved: number;
  files_attempted: number;
}

export interface BuildGuidelinesErrorEvent {
  type: "error";
  message: string;
}

export type BuildGuidelinesEvent =
  | BuildGuidelinesFileEvent
  | BuildGuidelinesStatusEvent
  | BuildGuidelinesDoneEvent
  | BuildGuidelinesErrorEvent;

async function streamSse<E = IngestUrlEvent>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(buildUrl(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`Request failed: ${res.status} ${res.statusText}`, res.status, text);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line.
    let sepIdx: number;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as E);
        } catch {
          // Ignore malformed lines.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export type EvaluationMethod = "ml" | "ai" | "both";
export type Engine = "ml" | "ai";
export type FindingSeverity = "minor" | "major" | "critical";

export type Provider = "anthropic" | "claude" | "gemini" | "google" | "openai" | "ollama" | "azure";

// Canonical provider keys sent to the backend. These MUST match the keys in
// server/app/engines/ai.py PROVIDERS (which are the env-var prefixes).
// Display labels (e.g. "Claude") live in the PROVIDER_OPTIONS arrays.
export type AiProvider = "anthropic" | "gemini" | "openai" | "ollama";

export type QuestionCategory =
  | "Security"
  | "Harmfulness"
  | "Fact-Check"
  | "Hallucination"
  | (string & {});

// ---------------------------------------------------------------------------
// Resource shapes — mirror backend Pydantic response models exactly.
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  chatbot_endpoint?: string | null;
  chatbot_request_template?: string | null;
  chatbot_response_path?: string | null;
  allowed_pii_patterns?: string;
}

export interface Document {
  id: string;
  project_id: string;
  filename: string;
  path: string;
  indexed_at: string | null;
  indexing_error?: string | null;
}

/** Alias preserved for existing consumers. */
export type DocumentFile = Document;

export interface DocumentContent {
  id: string;
  filename: string;
  path: string;
  kind: "file" | "url" | "consolidated";
  content: string | null;
  url: string | null;
  distilled?: boolean;
}

/** Minimal project shape used by selector UIs. */
export interface ProjectSummary {
  id: string;
  name: string;
}

export interface GuidelineFile {
  id: string;
  project_id: string;
  filename: string;
  path: string;
  content: string;
  uploaded_at: string;
}

export interface Question {
  id: string | null;
  category: string;
  text: string;
  project_id: string | null;
  expected_behavior: string | null;
  is_seed: boolean;
}

/**
 * Legacy alias preserved for existing consumers. Treats `id` as a guaranteed
 * string — pages that need to handle id-less seed entries should use the
 * canonical `Question` interface instead.
 */
export interface QuestionItem {
  id: string;
  text: string;
  category: string;
  project_id?: string | null;
  expected_behavior?: string | null;
  is_seed?: boolean;
}

export interface RetrievedChunk {
  document_id?: string | null;
  filename?: string | null;
  text: string;
  source?: string | null;
  score?: number | null;
}

export interface ReferenceAnswer {
  project_id: string;
  question: string;
  answer: string;
  retrieved_chunks: RetrievedChunk[];
  cached: boolean;
  created_at: string | null;
}

// ---------------------------------------------------------------------------
// Evaluation request + response
// ---------------------------------------------------------------------------

export interface EvaluationRequest {
  project_id: string;
  question: string;
  chatbot_response: string;
  reference_answer?: string | null;
  method?: EvaluationMethod;
  ai_provider?: string | null;
  ai_model?: string | null;
  weights?: Record<string, number>;
}

/** Legacy alias. */
export type EvaluateRequest = EvaluationRequest;

export interface MetricScoreOut {
  engine: Engine;
  metric_name: string;
  value: number;
  weight: number;
}

/** Legacy alias for sub-metric row. */
export type SubMetric = MetricScoreOut;

export interface GuidelineFindingOut {
  guideline_excerpt: string;
  offending_span: string;
  reason: string;
  severity: FindingSeverity | string | null;
}

/**
 * Legacy alias with a strict `severity` union — matches what older UI
 * components expect. The wire type (GuidelineFindingOut) is looser because
 * the backend may emit `null` when the judge omits a severity.
 */
export interface GuidelineFinding {
  guideline_excerpt: string;
  offending_span: string;
  reason: string;
  severity: FindingSeverity;
}

export interface DimensionBreakdown {
  similarity: number;
  accuracy: number;
  completeness: number;
  relevance: number;
  readability: number;
}

export type PIIKind = "email" | "phone" | "ssn" | "cc";

export interface PIIHit {
  kind: PIIKind;
  span: string;
  start: number;
  end: number;
}

// CUSTOM_CHECKS_DISABLED — types kept for re-enable; UI is gated off.
/** A plain-English check the AI judge evaluates alongside the standard
 * dimensions. ``weight`` of 0 = informational only (the score is shown but
 * does not factor into the combined score). */
export interface CustomCheck {
  id: string;
  project_id: string;
  description: string;
  weight: number;
  created_at: string;
}

export interface CustomCheckInput {
  description: string;
  weight?: number;
}

/** One per-check result emitted by the AI judge. The ``description`` is
 * looked up server-side so the panel never needs a second fetch. */
export interface CustomCheckResult {
  id: string;
  description: string;
  score: number;
  passed: boolean;
  reason: string;
  weight: number;
}

/** Full evaluation result returned by POST /api/evaluate and GET /api/evaluations/{id}. */
export interface EvaluationResult {
  id: string;
  project_id: string;
  question: string;
  chatbot_response: string;
  reference_answer: string;
  method: EvaluationMethod;
  ai_provider: string | null;

  // Score tiles
  ml_score: number | null;
  ai_score: number | null;
  combined_score: number | null;

  // Token usage (nullable; absent on older servers / non-AI methods)
  judge_prompt_tokens?: number | null;
  judge_completion_tokens?: number | null;
  judge_total_tokens?: number | null;
  reference_prompt_tokens?: number | null;
  reference_completion_tokens?: number | null;
  reference_total_tokens?: number | null;
  chatbot_prompt_tokens?: number | null;
  chatbot_completion_tokens?: number | null;
  chatbot_total_tokens?: number | null;

  // Per-dimension breakdowns
  ml_dimensions: DimensionBreakdown | null;
  ai_dimensions: DimensionBreakdown | null;

  // ML / AI sub-metric rows (semantic, lexical, readability, factual, etc.)
  ml_metrics: MetricScoreOut[];
  ai_metrics: MetricScoreOut[];

  // Findings + retrieved context + rationale
  guideline_findings: GuidelineFindingOut[];
  retrieved_chunks: RetrievedChunk[];
  rationale: string | null;
  created_at: string | null;

  /** True when scoring is in refusal-aware override mode (intent-match scoring
   * for a correct refusal answer). Default false. */
  refusal_mode?: boolean;

  /** Deterministic PII matches found in chatbot_response. Empty when clean. */
  pii_hits?: PIIHit[];

  /** Per-project plain-English custom-check results from the AI judge. Each
   * tile is shown inline in the evaluation panel with the judge's reason. */
  custom_check_results?: CustomCheckResult[];

  /** Set when the evaluation was produced as part of a dataset run; lets the
   * detail page link back to the run + dataset. Null for ad-hoc runs. */
  dataset_run_id?: string | null;
  dataset_run_name?: string | null;
  dataset_id?: string | null;
  dataset_name?: string | null;
  dataset_row_id?: string | null;
  /** Multi-turn conversation transcript for the source dataset row. Empty
   * when single-turn — render `question` as a single block instead. */
  turns?: { role: string; content: string }[];

  /** Manual reviewer override. When `override_verdict` is set, it wins over
   * combined_score >= 75 in pass-rate / regression / cluster analytics. */
  override_verdict?: "pass" | "fail" | null;
  override_note?: string | null;
  override_author?: string | null;
  override_created_at?: string | null;
}

/** Convenience alias for the detail endpoint. Same shape as EvaluationResult. */
export type EvaluationDetail = EvaluationResult;

/** How an evaluation was produced. Drives the run-type badge on the
 * Activity tab. New values may be added server-side; treat as open string. */
export type RunType = "single" | "multi_turn" | "dataset" | "scheduled" | (string & {});

/** Row shape returned by GET /api/evaluations (list). */
export interface EvaluationSummary {
  id: string;
  project_id: string;
  project_name: string | null;
  question: string;
  method: string;
  ai_provider: string | null;
  ml_score: number | null;
  ai_score: number | null;
  combined_score: number | null;
  /** Defaults to "single" if older servers don't send it. */
  run_type?: RunType;
  judge_total_tokens?: number | null;
  reference_total_tokens?: number | null;
  chatbot_total_tokens?: number | null;
  total_tokens?: number | null;
  created_at: string;
  // Optional fields the backend may attach in future / older clients expect.
  category?: string | null;
  dimensions?: Record<string, number>;
  override_verdict?: "pass" | "fail" | null;
  override_note?: string | null;
  override_author?: string | null;
  override_created_at?: string | null;
}

/** Legacy alias used by existing dashboard page. */
export type EvaluationListItem = EvaluationSummary;

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface TokensByRunPoint {
  run_name: string;
  started_at: string;
  judge: number;
  reference: number;
  chatbot: number;
  total: number;
}

export interface AnalyticsSummary {
  total_evaluations: number;
  average_score: number;
  pass_rate: number;
  this_week: number;
  latest_run_count?: number;
  safety_questions: number;
  entity_agreement: number;
  total_judge_tokens?: number;
  total_reference_tokens?: number;
  total_chatbot_tokens?: number;
  total_tokens?: number;
  tokens_by_run?: TokensByRunPoint[];
}

export interface TopTokenEvaluation {
  id: string;
  question: string;
  judge_total_tokens: number;
  reference_total_tokens: number;
  chatbot_total_tokens: number;
  total_tokens: number;
  created_at: string;
}

export interface RunNameItem {
  name: string;
  started_at: string;
  run_count: number;
}

export interface RegressionItem {
  question: string;
  dataset_name: string;
  base_score: number | null;
  head_score: number | null;
  eval_id_base: string | null;
  eval_id_head: string | null;
  category: string | null;
  severity: string | null;
}

export interface PerDatasetDelta {
  dataset_name: string;
  base_pass_rate: number;
  head_pass_rate: number;
  delta_pp: number;
}

export interface RegressionResponse {
  base_run_name: string;
  head_run_name: string;
  newly_broken: RegressionItem[];
  newly_fixed: RegressionItem[];
  still_failing: RegressionItem[];
  still_passing_count: number;
  per_dataset: PerDatasetDelta[];
  summary: {
    newly_broken_count: number;
    newly_fixed_count: number;
    still_failing_count: number;
    still_passing_count: number;
    net_delta_pp: number;
  };
}

export interface FailureCluster {
  category: string;
  tag: string;
  failure_count: number;
  severity_score: number;
  sample_questions: string[];
}

export interface FailureClustersResponse {
  clusters: FailureCluster[];
  run_name: string | null;
}

export interface SeverityTrendPoint {
  run_name: string;
  started_at: string;
  critical: number;
  major: number;
  minor: number;
}

export interface SeverityTrendResponse {
  series: SeverityTrendPoint[];
}

export interface AgreementPoint {
  evaluation_id: string;
  ml_score: number;
  ai_score: number;
  question: string | null;
  category: string | null;
}

export interface AgreementResponse {
  points: AgreementPoint[];
  correlation: number | null;
}

// ---------------------------------------------------------------------------
// Endpoint methods
// ---------------------------------------------------------------------------

interface ProjectCreateInput {
  name: string;
  description?: string | null;
}

interface QuestionCreateInput {
  text: string;
  category: string;
  projectId?: string | null;
  expectedBehavior?: string | null;
}

interface QuestionListParams {
  category?: string;
  projectId?: string;
}

interface ReferenceGenerateInput {
  question: string;
  provider?: string | null;
  forceRegenerate?: boolean;
}

/**
 * Method-level param objects. Snake_case forms are accepted so callers that
 * already build snake_case query bags don't need to translate; camelCase
 * forms are also accepted for new code. When both are present, camelCase wins.
 */
export interface EvaluationListParams {
  projectId?: string;
  project_id?: string;
  method?: string;
  limit?: number;
  offset?: number;
  since?: string | Date;
  until?: string | Date;
  date_range?: string;
}

export interface AnalyticsParams {
  projectId?: string;
  project_id?: string;
  since?: string | Date;
  until?: string | Date;
  date_range?: string;
  category?: string;
  method?: string;
}

function toIso(v: string | Date | undefined): string | undefined {
  if (v === undefined) return undefined;
  return v instanceof Date ? v.toISOString() : v;
}

function uploadForm(file: File): FormData {
  const fd = new FormData();
  fd.append("file", file);
  return fd;
}

export const api = {
  projects: {
    list: () => apiFetch<Project[]>("/api/projects"),
    create: (input: ProjectCreateInput) =>
      apiFetch<Project>("/api/projects", {
        method: "POST",
        body: { name: input.name, description: input.description ?? null },
      }),
    get: (id: string) => apiFetch<Project>(`/api/projects/${id}`),
    update: (
      id: string,
      input: {
        name?: string;
        description?: string | null;
        chatbot_endpoint?: string | null;
        chatbot_request_template?: string | null;
        chatbot_response_path?: string | null;
        allowed_pii_patterns?: string | null;
      },
    ) =>
      apiFetch<Project>(`/api/projects/${id}`, {
        method: "PATCH",
        body: input,
      }),
    delete: (id: string) => apiFetch<null>(`/api/projects/${id}`, { method: "DELETE" }),
  },

  documents: {
    list: (projectId: string) => apiFetch<Document[]>(`/api/projects/${projectId}/documents`),
    upload: (projectId: string, file: File) =>
      apiFetch<Document>(`/api/projects/${projectId}/documents`, {
        method: "POST",
        body: uploadForm(file),
      }),
    delete: (projectId: string, documentId: string) =>
      apiFetch<null>(`/api/projects/${projectId}/documents/${documentId}`, { method: "DELETE" }),
    discoverUrls: (projectId: string, url: string, max_pages = 50) =>
      apiFetch<{ urls: string[] }>(
        `/api/projects/${projectId}/documents/url/discover`,
        { method: "POST", body: { url, max_pages } },
      ),
    ingestUrl: (
      projectId: string,
      body: {
        url?: string;
        max_pages?: number;
        urls?: string[];
        smart_extract?: boolean;
        provider?: string;
      },
      onEvent: (event: IngestUrlEvent) => void,
      signal?: AbortSignal,
    ) =>
      streamSse<IngestUrlEvent>(
        `/api/projects/${projectId}/documents/url`,
        body,
        onEvent,
        signal,
      ),
    content: (projectId: string, documentId: string) =>
      apiFetch<DocumentContent>(
        `/api/projects/${projectId}/documents/${documentId}/content`,
      ),
  },

  guidelines: {
    list: (projectId: string) => apiFetch<GuidelineFile[]>(`/api/projects/${projectId}/guidelines`),
    upload: (projectId: string, file: File) =>
      apiFetch<GuidelineFile>(`/api/projects/${projectId}/guidelines`, {
        method: "POST",
        body: uploadForm(file),
      }),
    update: (projectId: string, guidelineId: string, content: string) =>
      apiFetch<GuidelineFile>(`/api/projects/${projectId}/guidelines/${guidelineId}`, {
        method: "PUT",
        body: { content },
      }),
    delete: (projectId: string, guidelineId: string) =>
      apiFetch<null>(`/api/projects/${projectId}/guidelines/${guidelineId}`, { method: "DELETE" }),
    build: (
      projectId: string,
      body: { provider?: string },
      onEvent: (event: BuildGuidelinesEvent) => void,
      signal?: AbortSignal,
    ) =>
      streamSse<BuildGuidelinesEvent>(
        `/api/projects/${projectId}/guidelines/build`,
        body,
        onEvent,
        signal,
      ),
  },

  questions: {
    list: (params: QuestionListParams = {}) =>
      apiFetch<Question[]>("/api/questions", {
        query: {
          category: params.category,
          project_id: params.projectId,
        },
      }),
    create: (input: QuestionCreateInput) =>
      apiFetch<Question>("/api/questions", {
        method: "POST",
        body: {
          text: input.text,
          category: input.category,
          project_id: input.projectId ?? null,
          expected_behavior: input.expectedBehavior ?? null,
        },
      }),
  },

  reference: {
    generate: (projectId: string, input: ReferenceGenerateInput) =>
      apiFetch<ReferenceAnswer>(`/api/projects/${projectId}/reference`, {
        method: "POST",
        body: {
          question: input.question,
          ai_provider: input.provider ?? null,
          force_regenerate: input.forceRegenerate ?? false,
        },
      }),
  },

  evaluate: {
    run: (req: EvaluationRequest) =>
      apiFetch<EvaluationResult>("/api/evaluate", {
        method: "POST",
        body: req,
      }),
  },

  evaluations: {
    list: (params: EvaluationListParams = {}) =>
      apiFetch<EvaluationSummary[]>("/api/evaluations", {
        query: {
          project_id: params.projectId ?? params.project_id,
          method: params.method,
          limit: params.limit,
          offset: params.offset,
          since: toIso(params.since),
          end_date: toIso(params.until),
          date_range: params.date_range,
        },
      }),
    get: (id: string) => apiFetch<EvaluationDetail>(`/api/evaluations/${id}`),
    setOverride: (
      id: string,
      input: { verdict: "pass" | "fail" | null; note: string },
    ) =>
      apiFetch<EvaluationDetail>(`/api/evaluations/${id}/override`, {
        method: "PATCH",
        body: { verdict: input.verdict, note: input.note },
      }),
  },

  analytics: {
    summary: (params: AnalyticsParams = {}) =>
      apiFetch<AnalyticsSummary>("/api/analytics/summary", {
        query: {
          project_id: params.projectId ?? params.project_id,
          start_date: toIso(params.since),
          end_date: toIso(params.until),
          date_range: params.date_range,
          category: params.category,
          method: params.method,
        },
      }),
    /** Full `{points, correlation}` envelope from the backend. */
    agreement: (params: AnalyticsParams = {}) =>
      apiFetch<AgreementResponse>("/api/analytics/agreement", {
        query: {
          project_id: params.projectId ?? params.project_id,
          start_date: toIso(params.since),
          end_date: toIso(params.until),
          date_range: params.date_range,
          category: params.category,
        },
      }),
    dateRange: (projectId: string) =>
      apiFetch<{ min: string | null; max: string | null }>(
        "/api/analytics/date-range",
        { query: { project_id: projectId } },
      ),
    runNames: (projectId: string) =>
      apiFetch<RunNameItem[]>("/api/analytics/run-names", {
        query: { project_id: projectId },
      }),
    regression: (params: {
      projectId: string;
      base_run_name: string;
      head_run_name: string;
    }) =>
      apiFetch<RegressionResponse>("/api/analytics/regression", {
        query: {
          project_id: params.projectId,
          base_run_name: params.base_run_name,
          head_run_name: params.head_run_name,
        },
      }),
    failureClusters: (projectId: string, runName?: string) =>
      apiFetch<FailureClustersResponse>("/api/analytics/failure-clusters", {
        query: { project_id: projectId, run_name: runName },
      }),
    severityTrend: (projectId: string) =>
      apiFetch<SeverityTrendResponse>("/api/analytics/severity-trend", {
        query: { project_id: projectId },
      }),
    topTokenEvaluations: (projectId: string, limit = 10) =>
      apiFetch<TopTokenEvaluation[]>("/api/analytics/top-token-evaluations", {
        query: { project_id: projectId, limit },
      }),
    /** Alias of `agreement` — kept for callers that name the raw envelope explicitly. */
    agreementRaw: (params: AnalyticsParams = {}) =>
      apiFetch<AgreementResponse>("/api/analytics/agreement", {
        query: {
          project_id: params.projectId ?? params.project_id,
          start_date: toIso(params.since),
          end_date: toIso(params.until),
          date_range: params.date_range,
          category: params.category,
        },
      }),
  },
};

// ---------------------------------------------------------------------------
// Multi-turn chat (Conversations)
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  position: number;
  role: Role;
  content: string;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
  /** User-supplied "what the bot should have said" override for assistant
   * turns. When set, conversation evaluation grades the assistant content
   * against this instead of a generated reference. */
  expected_response?: string | null;
  created_at?: string | null;
}

/** Shape allowed when creating a conversation or pasting JSON. */
export interface MessageInput {
  role: Role;
  content: string;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
  expected_response?: string | null;
}

export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at?: string | null;
  messages: Message[];
}

export interface ConversationListItem {
  id: string;
  project_id: string;
  title: string;
  turn_count: number;
  created_at: string;
  updated_at?: string | null;
}

export interface TurnEvaluation {
  id: string;
  message_id: string;
  position: number;
  user_prompt: string;
  assistant_response: string;
  reference_answer: string | null;
  ml_score: number | null;
  ai_score: number | null;
  combined_score: number | null;
  rationale: string | null;
  ml_dimensions: DimensionBreakdown | null;
  ai_dimensions: DimensionBreakdown | null;
  ml_metrics: MetricScoreOut[];
  ai_metrics: MetricScoreOut[];
  guideline_findings: GuidelineFindingOut[];
  retrieved_chunks: RetrievedChunk[];
  pii_hits?: PIIHit[];
  custom_check_results?: CustomCheckResult[];
  judge_prompt_tokens?: number | null;
  judge_completion_tokens?: number | null;
  judge_total_tokens?: number | null;
  reference_prompt_tokens?: number | null;
  reference_completion_tokens?: number | null;
  reference_total_tokens?: number | null;
  chatbot_prompt_tokens?: number | null;
  chatbot_completion_tokens?: number | null;
  chatbot_total_tokens?: number | null;
}

export interface ConversationSummary {
  average_combined: number | null;
  min_combined: number | null;
  max_combined: number | null;
  turn_count: number;
}

export interface ConversationEvaluationResult {
  id: string;
  conversation_id: string;
  method: EvaluationMethod;
  ai_provider: string | null;
  created_at: string;
  turn_evaluations: TurnEvaluation[];
  summary: ConversationSummary;
}

export interface ConversationCreateInput {
  title: string;
  messages?: MessageInput[];
}

export interface ConversationEvaluateInput {
  method: EvaluationMethod;
  ai_provider?: string | null;
}

const conversationsApi = {
  list: (projectId: string) =>
    apiFetch<ConversationListItem[]>(`/api/projects/${projectId}/conversations`),
  create: (projectId: string, input: ConversationCreateInput) =>
    apiFetch<Conversation>(`/api/projects/${projectId}/conversations`, {
      method: "POST",
      body: { title: input.title, messages: input.messages ?? [] },
    }),
  get: (id: string) => apiFetch<Conversation>(`/api/conversations/${id}`),
  updateTitle: (id: string, title: string) =>
    apiFetch<Conversation>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: { title },
    }),
  delete: (id: string) => apiFetch<null>(`/api/conversations/${id}`, { method: "DELETE" }),

  appendMessage: (id: string, msg: MessageInput) =>
    apiFetch<Message>(`/api/conversations/${id}/messages`, {
      method: "POST",
      body: msg,
    }),
  updateMessage: (id: string, messageId: string, msg: MessageInput) =>
    apiFetch<Message>(`/api/conversations/${id}/messages/${messageId}`, {
      method: "PUT",
      body: msg,
    }),
  reorderMessage: (id: string, messageId: string, position: number) =>
    apiFetch<Message>(`/api/conversations/${id}/messages/${messageId}/reorder`, {
      method: "PATCH",
      body: { position },
    }),
  deleteMessage: (id: string, messageId: string) =>
    apiFetch<null>(`/api/conversations/${id}/messages/${messageId}`, {
      method: "DELETE",
    }),

  evaluate: (id: string, input: ConversationEvaluateInput) =>
    apiFetch<ConversationEvaluationResult>(`/api/conversations/${id}/evaluate`, {
      method: "POST",
      body: {
        method: input.method,
        ai_provider: input.ai_provider ?? null,
      },
    }),
};

export { conversationsApi };

// ---------------------------------------------------------------------------
// Datasets + Batch Evaluation
// ---------------------------------------------------------------------------

export type DatasetRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DatasetRow {
  id: string;
  dataset_id: string;
  position: number;
  question: string;
  expected_response: string | null;
  chatbot_response: string | null;
  tags: string[];
  category: string | null;
  /** "manual" | "endpoint:<id>" | null (= use run default) */
  chatbot_source: string | null;
  /** Multi-turn transcript. Empty list = single-turn row. */
  turns: ChatTurn[];
}

export interface DatasetLastRunSummary {
  id: string;
  name?: string | null;
  status: DatasetRunStatus | string;
  started_at: string;
  finished_at: string | null;
  completed_rows: number;
  total_rows: number;
  pass_rate: number | null;
  avg_combined: number | null;
}

export interface Dataset {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  row_count: number;
  last_run: DatasetLastRunSummary | null;
  rows?: DatasetRow[];
}

export interface DatasetRunItem {
  id: string;
  dataset_row_id: string;
  evaluation_id: string | null;
  error: string | null;
  question: string | null;
  tags: string[];
  category: string | null;
  combined_score: number | null;
  ml_score: number | null;
  ai_score: number | null;
  judge_total_tokens?: number | null;
  reference_total_tokens?: number | null;
  chatbot_total_tokens?: number | null;
  total_tokens?: number | null;
}

export interface TagSummary {
  tag: string;
  count: number;
  avg_combined: number | null;
  pass_rate: number | null;
}

export interface CategorySummary {
  category: string;
  count: number;
  avg_combined: number | null;
  pass_rate: number | null;
}

export interface DatasetRunSummary {
  avg_combined: number | null;
  pass_rate: number | null;
  total_rows: number;
  by_tag: TagSummary[];
  by_category: CategorySummary[];
  total_judge_tokens?: number;
  total_reference_tokens?: number;
  total_chatbot_tokens?: number;
  total_tokens?: number;
}

export interface DatasetRun {
  id: string;
  dataset_id: string;
  project_id: string;
  name?: string | null;
  method: EvaluationMethod | string;
  ai_provider: string | null;
  status: DatasetRunStatus | string;
  started_at: string;
  finished_at: string | null;
  total_rows: number;
  completed_rows: number;
  error: string | null;
  chatbot_endpoint_id?: string | null;
  chatbot_endpoint_name?: string | null;
  chatbot_endpoint_url?: string | null;
  items: DatasetRunItem[];
  summary: DatasetRunSummary | null;
}

export interface DatasetRunHeatmapRow {
  row_id: string;
  position: number;
  question: string;
  tags: string[];
  category: string | null;
  status: "completed" | "pending" | "error";
  combined_score: number | null;
  passed: boolean | null;
  dimensions: Record<string, number>;
  engine_scores: Record<string, number>;
  error?: string | null;
}

export interface DatasetRunHeatmap {
  run_id: string;
  status: string;
  total_rows: number;
  completed_rows: number;
  passing_rows: number;
  rows: DatasetRunHeatmapRow[];
}

// SCHEDULE_DISABLED — type retained for re-enable
export interface DatasetSchedule {
  dataset_id: string;
  cron: string | null;
  enabled: boolean;
}

export interface DatasetRowInput {
  question: string;
  expected_response?: string | null;
  chatbot_response?: string | null;
  tags?: string[];
  category?: string | null;
  /** "manual" | "endpoint:<id>" | null (= use run default) */
  chatbot_source?: string | null;
  /** Multi-turn transcript. Omit / empty list for single-turn rows. */
  turns?: ChatTurn[];
}

export interface DatasetRunRequest {
  method?: EvaluationMethod;
  ai_provider?: string | null;
  tag_filter?: string[];
  chatbot_endpoint_id?: string | null;
  name?: string | null;
}

// ---------------------------------------------------------------------------
// Chatbot endpoints
// ---------------------------------------------------------------------------

export interface ChatbotEndpoint {
  id: string;
  project_id: string;
  name: string;
  url: string;
  method: string;
  headers_json: string;
  request_template: string;
  response_path: string;
  tokens_prompt_path: string | null;
  tokens_completion_path: string | null;
  tokens_total_path: string | null;
  timeout_seconds: number;
  is_default: boolean;
  created_at: string;
}

export interface ChatbotEndpointInput {
  name: string;
  url: string;
  method?: string;
  headers_json?: string;
  request_template?: string;
  response_path?: string;
  tokens_prompt_path?: string | null;
  tokens_completion_path?: string | null;
  tokens_total_path?: string | null;
  timeout_seconds?: number;
  is_default?: boolean;
}

export interface ChatbotEndpointTestResult {
  response_text: string;
  raw_response: unknown;
  response_path_resolved: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number;
  error: string | null;
}

const chatbotEndpointsApi = {
  list: (projectId: string) =>
    apiFetch<ChatbotEndpoint[]>(
      `/api/projects/${projectId}/chatbot-endpoints`,
    ),
  create: (projectId: string, input: ChatbotEndpointInput) =>
    apiFetch<ChatbotEndpoint>(
      `/api/projects/${projectId}/chatbot-endpoints`,
      { method: "POST", body: input },
    ),
  get: (id: string) =>
    apiFetch<ChatbotEndpoint>(`/api/chatbot-endpoints/${id}`),
  update: (id: string, input: Partial<ChatbotEndpointInput>) =>
    apiFetch<ChatbotEndpoint>(`/api/chatbot-endpoints/${id}`, {
      method: "PATCH",
      body: input,
    }),
  delete: (id: string) =>
    apiFetch<null>(`/api/chatbot-endpoints/${id}`, { method: "DELETE" }),
  test: (id: string, input: { question: string }) =>
    apiFetch<ChatbotEndpointTestResult>(
      `/api/chatbot-endpoints/${id}/test`,
      { method: "POST", body: input },
    ),
};

(api as unknown as Record<string, unknown>).chatbotEndpoints =
  chatbotEndpointsApi;

export { chatbotEndpointsApi };

const datasetsApi = {
  listByProject: (projectId: string) =>
    apiFetch<Dataset[]>(`/api/projects/${projectId}/datasets`),
  create: (
    projectId: string,
    input: { name: string; description?: string | null },
  ) =>
    apiFetch<Dataset>(`/api/projects/${projectId}/datasets`, {
      method: "POST",
      body: { name: input.name, description: input.description ?? null },
    }),
  get: (id: string) => apiFetch<Dataset>(`/api/datasets/${id}`),
  update: (
    id: string,
    input: { name?: string; description?: string | null },
  ) =>
    apiFetch<Dataset>(`/api/datasets/${id}`, {
      method: "PATCH",
      body: input,
    }),
  delete: (id: string) =>
    apiFetch<null>(`/api/datasets/${id}`, { method: "DELETE" }),

  addRow: (id: string, row: DatasetRowInput) =>
    apiFetch<DatasetRow>(`/api/datasets/${id}/rows`, {
      method: "POST",
      body: {
        question: row.question,
        expected_response: row.expected_response ?? null,
        chatbot_response: row.chatbot_response ?? null,
        tags: row.tags ?? [],
        category: row.category ?? null,
        chatbot_source: row.chatbot_source ?? null,
        turns: row.turns ?? [],
      },
    }),
  bulkAddRows: (id: string, rows: DatasetRowInput[]) =>
    apiFetch<DatasetRow[]>(`/api/datasets/${id}/rows/bulk`, {
      method: "POST",
      body: { rows },
    }),
  updateRow: (id: string, rowId: string, input: DatasetRowInput) =>
    apiFetch<DatasetRow>(`/api/datasets/${id}/rows/${rowId}`, {
      method: "PUT",
      body: {
        question: input.question,
        expected_response: input.expected_response ?? null,
        chatbot_response: input.chatbot_response ?? null,
        tags: input.tags ?? [],
        category: input.category ?? null,
        chatbot_source: input.chatbot_source ?? null,
        turns: input.turns ?? [],
      },
    }),
  deleteRow: (id: string, rowId: string) =>
    apiFetch<null>(`/api/datasets/${id}/rows/${rowId}`, { method: "DELETE" }),

  importFile: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<{ imported: number; errors: string[] }>(
      `/api/datasets/${id}/import`,
      { method: "POST", body: fd },
    );
  },

  run: (id: string, input: DatasetRunRequest) =>
    apiFetch<DatasetRun>(`/api/datasets/${id}/run`, {
      method: "POST",
      body: {
        method: input.method ?? "both",
        ai_provider: input.ai_provider ?? null,
        tag_filter: input.tag_filter ?? [],
        chatbot_endpoint_id: input.chatbot_endpoint_id ?? null,
        name: input.name ?? null,
      },
    }),
  runAll: (
    projectId: string,
    input: DatasetRunRequest,
  ) =>
    apiFetch<{ name: string | null; runs: DatasetRun[] }>(
      `/api/projects/${projectId}/run-all-datasets`,
      {
        method: "POST",
        body: {
          method: input.method ?? "ai",
          ai_provider: input.ai_provider ?? null,
          tag_filter: input.tag_filter ?? [],
          chatbot_endpoint_id: input.chatbot_endpoint_id ?? null,
          name: input.name ?? null,
        },
      },
    ),
  getRun: (runId: string) =>
    apiFetch<DatasetRun>(`/api/dataset-runs/${runId}`),
  getRunHeatmap: (runId: string) =>
    apiFetch<DatasetRunHeatmap>(`/api/dataset-runs/${runId}/heatmap`),
  runsByDataset: (datasetId: string) =>
    apiFetch<DatasetRun[]>(`/api/datasets/${datasetId}/runs`),
  runsByProject: (projectId: string) =>
    apiFetch<DatasetRun[]>(`/api/projects/${projectId}/dataset-runs`),
  cancelRun: (id: string, runId: string) =>
    apiFetch<DatasetRun>(`/api/datasets/${id}/runs/${runId}/cancel`, {
      method: "POST",
    }),

  // SCHEDULE_DISABLED — methods retained for re-enable
  getSchedule: (id: string) =>
    apiFetch<DatasetSchedule>(`/api/datasets/${id}/schedule`),
  setSchedule: (id: string, input: { cron?: string | null; enabled: boolean }) =>
    apiFetch<DatasetSchedule>(`/api/datasets/${id}/schedule`, {
      method: "POST",
      body: { cron: input.cron ?? null, enabled: input.enabled },
    }),
};

// Attach to main api namespace too so callers can use `api.datasets.*`.
(api as unknown as Record<string, unknown>).datasets = datasetsApi;

export { datasetsApi };

// CUSTOM_CHECKS_DISABLED — namespace kept so re-enabling only needs the UI
// re-wiring (see app/projects/[id]/page.tsx). Server routes are stubbed-out
// while disabled, so calls will 404 — do not invoke from new code.
const customChecksApi = {
  list: (projectId: string) =>
    apiFetch<CustomCheck[]>(`/api/projects/${projectId}/custom-checks`),
  create: (projectId: string, input: CustomCheckInput) =>
    apiFetch<CustomCheck>(`/api/projects/${projectId}/custom-checks`, {
      method: "POST",
      body: {
        description: input.description,
        weight: input.weight ?? 0,
      },
    }),
  update: (
    id: string,
    input: { description?: string; weight?: number },
  ) =>
    apiFetch<CustomCheck>(`/api/custom-checks/${id}`, {
      method: "PATCH",
      body: input,
    }),
  delete: (id: string) =>
    apiFetch<null>(`/api/custom-checks/${id}`, { method: "DELETE" }),
};

(api as unknown as Record<string, unknown>).customChecks = customChecksApi;

export { customChecksApi };

export type Api = typeof api & {
  datasets: typeof datasetsApi;
  chatbotEndpoints: typeof chatbotEndpointsApi;
  customChecks: typeof customChecksApi;
};
