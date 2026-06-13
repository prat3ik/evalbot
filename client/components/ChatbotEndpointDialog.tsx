"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Check, X } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { cn } from "@/lib/cn";

export type EndpointKind = "llm" | "dummy" | "user";

export function classifyEndpointUrl(url: string): EndpointKind {
  if (!url) return "user";
  if (
    url.includes("/api/dummy-chatbot/lumen-llm") ||
    url.includes("/api/dummy-chatbot/llm")
  ) {
    return "llm";
  }
  if (url.includes("/api/dummy-chatbot/")) {
    return "dummy";
  }
  return "user";
}

export function EndpointKindBadge({ url }: { url: string }) {
  const kind = classifyEndpointUrl(url);
  if (kind === "llm") {
    return (
      <Badge
        variant="accent"
        title="This endpoint forwards to a real LLM (via your configured AI provider)."
      >
        LLM
      </Badge>
    );
  }
  if (kind === "dummy") {
    return (
      <Badge
        variant="neutral"
        title="This is a built-in rule-based responder for demos. Configure your own URL to test a real chatbot."
      >
        DUMMY
      </Badge>
    );
  }
  return null;
}
import {
  chatbotEndpointsApi,
  type ChatbotEndpoint,
  type ChatbotEndpointInput,
  type ChatbotEndpointTestResult,
} from "@/lib/api";

const DEFAULT_TEMPLATE = '{"question": "{{question}}"}';
const DEFAULT_RESP_PATH = "$.response";
const DEFAULT_TEST_QUESTION = "What's the refund window for Pro plan?";

export function ChatbotEndpointDialog({
  projectId,
  endpoint,
  onClose,
  onSaved,
}: {
  projectId: string;
  endpoint: ChatbotEndpoint | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [createdId, setCreatedId] = React.useState<string | null>(null);
  const editingId = endpoint?.id ?? createdId;
  const isEdit = editingId != null;
  const [name, setName] = React.useState(endpoint?.name ?? "");
  const [url, setUrl] = React.useState(endpoint?.url ?? "");
  const [method, setMethod] = React.useState(endpoint?.method ?? "POST");
  const [headersJson, setHeadersJson] = React.useState(
    endpoint?.headers_json ?? "{}",
  );
  const [reqTemplate, setReqTemplate] = React.useState(
    endpoint?.request_template ?? DEFAULT_TEMPLATE,
  );
  const [respPath, setRespPath] = React.useState(
    endpoint?.response_path ?? DEFAULT_RESP_PATH,
  );
  const [promptPath, setPromptPath] = React.useState(
    endpoint?.tokens_prompt_path ?? "",
  );
  const [completionPath, setCompletionPath] = React.useState(
    endpoint?.tokens_completion_path ?? "",
  );
  const [totalPath, setTotalPath] = React.useState(
    endpoint?.tokens_total_path ?? "",
  );
  const [timeout, setTimeout] = React.useState(
    String(endpoint?.timeout_seconds ?? 30),
  );
  const [testQuestion, setTestQuestion] = React.useState(
    DEFAULT_TEST_QUESTION,
  );
  const [testResult, setTestResult] =
    React.useState<ChatbotEndpointTestResult | null>(null);
  const [rawOpen, setRawOpen] = React.useState(false);
  const [responseExpanded, setResponseExpanded] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );

  const tokenPathCount =
    (promptPath.trim() ? 1 : 0) +
    (completionPath.trim() ? 1 : 0) +
    (totalPath.trim() ? 1 : 0);

  function validate(): string | null {
    if (!name.trim()) return "name required";
    if (!url.trim()) return "url required";
    try {
      new URL(url);
    } catch {
      return "url must be a valid URL";
    }
    if (!reqTemplate.trim()) return "request_template required";
    try {
      // Substitute placeholders with JSON-safe tokens BEFORE parsing.
      // `{{question}}` is typically used inside quotes (`"{{question}}"`) so we
      // replace it with a bare identifier-like string. `{{conversation}}` may
      // be used as an array, so we substitute an empty array literal.
      const probe = reqTemplate
        .replace(/\{\{\s*question\s*\}\}/g, "__Q__")
        .replace(/\{\{\s*conversation\s*\}\}/g, "[]");
      JSON.parse(probe);
    } catch {
      return "request_template must be valid JSON (with {{question}} placeholder)";
    }
    if (!respPath.trim()) return "response_path required";
    try {
      JSON.parse(headersJson || "{}");
    } catch {
      return "headers_json must be valid JSON";
    }
    return null;
  }

  function buildInput(): ChatbotEndpointInput {
    return {
      name: name.trim(),
      url: url.trim(),
      method: method.toUpperCase(),
      headers_json: headersJson || "{}",
      request_template: reqTemplate,
      response_path: respPath.trim() || DEFAULT_RESP_PATH,
      tokens_prompt_path: promptPath.trim() || null,
      tokens_completion_path: completionPath.trim() || null,
      tokens_total_path: totalPath.trim() || null,
      timeout_seconds: Number(timeout) || 30,
    };
  }

  const saveMut = useMutation({
    mutationFn: () => {
      const err = validate();
      if (err) return Promise.reject(new Error(err));
      const input = buildInput();
      return editingId
        ? chatbotEndpointsApi.update(editingId, input)
        : chatbotEndpointsApi.create(projectId, input);
    },
    onSuccess: () => onSaved(),
  });

  const testMut = useMutation({
    mutationFn: async (): Promise<ChatbotEndpointTestResult> => {
      const err = validate();
      if (err) throw new Error(err);
      const input = buildInput();
      const saved = editingId
        ? await chatbotEndpointsApi.update(editingId, input)
        : await chatbotEndpointsApi.create(projectId, input);
      if (!editingId) setCreatedId(saved.id);
      return chatbotEndpointsApi.test(saved.id, {
        question: testQuestion.trim(),
      });
    },
    onSuccess: (r) => setTestResult(r),
  });

  React.useEffect(() => {
    setValidationError(validate());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, url, reqTemplate, respPath, headersJson]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? "Edit endpoint" : "Add endpoint"}
      className="w-[min(1120px,calc(100vw-32px))] max-w-none"
    >
      <div className="max-h-[80vh] overflow-x-hidden overflow-y-auto">
        <div className="flex flex-col">
          {/* Section 1 — Connection: Name + Method + URL on one row */}
          <Section title="Connection" first>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_110px_minmax(0,2fr)]">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Lumen v1 prod"
                />
              </Field>
              <Field label="Method">
                <Select
                  value={method.toUpperCase()}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="URL" labelExtra={<EndpointKindBadge url={url} />}>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://your-bot.example.com/chat"
                  className="font-mono text-[13px]"
                />
              </Field>
            </div>
          </Section>

          {/* Section 2 — Request body + Headers side-by-side */}
          <Section title="Request">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Body template (JSON)"
                hint={
                  <>
                    Use <code className="font-mono">{"{{question}}"}</code>; optional{" "}
                    <code className="font-mono">{"{{conversation}}"}</code> for history.
                  </>
                }
              >
                <Textarea
                  value={reqTemplate}
                  onChange={(e) => setReqTemplate(e.target.value)}
                  className="min-h-[112px] font-mono text-[13px]"
                  placeholder='{"question": "{{question}}"}'
                />
              </Field>
              <Field
                label="Headers (JSON)"
                hint="Optional. Static headers for auth."
              >
                <Textarea
                  value={headersJson}
                  onChange={(e) => setHeadersJson(e.target.value)}
                  className="min-h-[112px] font-mono text-[13px]"
                  placeholder='{"Authorization": "Bearer ..."}'
                />
              </Field>
            </div>
          </Section>

          {/* Section 3 — Response parsing + Token tracking side-by-side */}
          <Section title="Response">
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_120px]">
                  <Field
                    label="Reply path"
                    hint={
                      <>
                        JSONPath into the response body. Supports{" "}
                        <code className="font-mono">$.a.b.c</code>.
                      </>
                    }
                  >
                    <Input
                      value={respPath}
                      onChange={(e) => setRespPath(e.target.value)}
                      placeholder="$.response"
                      className="font-mono text-[13px]"
                    />
                  </Field>
                  <Field label="Timeout (s)">
                    <Input
                      value={timeout}
                      onChange={(e) => setTimeout(e.target.value)}
                      type="number"
                      min={1}
                      max={300}
                    />
                  </Field>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
                    Token tracking
                  </label>
                  <span className="font-sans text-[11px] text-text-subtle">
                    {tokenPathCount > 0
                      ? `${tokenPathCount} of 3 configured`
                      : "optional"}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <Input
                    value={promptPath}
                    onChange={(e) => setPromptPath(e.target.value)}
                    placeholder="$.usage.prompt_tokens"
                    className="font-mono text-[12px]"
                    title="Prompt tokens path"
                  />
                  <Input
                    value={completionPath}
                    onChange={(e) => setCompletionPath(e.target.value)}
                    placeholder="$.usage.completion_tokens"
                    className="font-mono text-[12px]"
                    title="Completion tokens path"
                  />
                  <Input
                    value={totalPath}
                    onChange={(e) => setTotalPath(e.target.value)}
                    placeholder="$.usage.total_tokens"
                    className="font-mono text-[12px]"
                    title="Total tokens path"
                  />
                </div>
                <p className="font-sans text-[11px] leading-[16px] text-text-subtle">
                  Where token counts live in your response body. Leave blank if
                  your bot doesn&apos;t return them.
                </p>
              </div>
            </div>
          </Section>

          {/* Section — Test connection (compact inline) */}
          <Section
            title="Test connection"
            titleExtra={
              <span className="font-sans text-[11px] text-text-subtle">
                Send a request to verify reachability.
              </span>
            }
          >
            <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
              <Input
                value={testQuestion}
                onChange={(e) => setTestQuestion(e.target.value)}
                placeholder="e.g. What's the refund policy?"
                className="flex-1"
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !testMut.isPending &&
                    validationError == null &&
                    testQuestion.trim()
                  ) {
                    e.preventDefault();
                    testMut.mutate();
                  }
                }}
              />
              <Button
                size="md"
                disabled={
                  testMut.isPending ||
                  validationError != null ||
                  !testQuestion.trim()
                }
                onClick={() => testMut.mutate()}
              >
                {testMut.isPending ? "Testing…" : "Run test"}
              </Button>
            </div>

            {testMut.isPending && (
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-[58px] animate-pulse rounded-md bg-surface-sunken"
                  />
                ))}
              </div>
            )}

            {!testMut.isPending && testMut.error instanceof Error && (
              <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
                <p className="font-sans text-[13px] font-medium text-danger">
                  {testMut.error.message}
                </p>
                <p className="mt-0.5 font-sans text-[12px] text-danger/80">
                  Check the URL, reply path, and that your endpoint is reachable.
                </p>
              </div>
            )}

            {!testMut.isPending && testResult && !testResult.error && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Stat label="Status">
                    <span className="inline-flex items-center gap-1 font-sans text-[13px] font-medium text-success">
                      <Check size={14} strokeWidth={2} /> Reached
                    </span>
                  </Stat>
                  <Stat label="Latency">
                    <span className="font-mono text-[14px] text-text">
                      {testResult.latency_ms}ms
                    </span>
                  </Stat>
                  <Stat label="Tokens (p/c/t)">
                    <span className="font-mono text-[13px] text-text">
                      {testResult.prompt_tokens ?? "—"}/
                      {testResult.completion_tokens ?? "—"}/
                      {testResult.total_tokens ?? "—"}
                    </span>
                  </Stat>
                  <Stat label="Response">
                    <button
                      type="button"
                      onClick={() => setResponseExpanded((x) => !x)}
                      className={cn(
                        "text-left font-sans text-[13px] text-text",
                        responseExpanded ? "" : "line-clamp-2",
                      )}
                      title={responseExpanded ? "Click to collapse" : "Click to expand"}
                    >
                      {testResult.response_text || "(empty)"}
                    </button>
                  </Stat>
                </div>
                <button
                  type="button"
                  onClick={() => setRawOpen((x) => !x)}
                  className="flex items-center gap-1 self-start font-sans text-[12px] text-accent-pressed hover:text-accent"
                >
                  <ChevronRight
                    size={12}
                    className={cn(
                      "transition-transform duration-[120ms]",
                      rawOpen && "rotate-90",
                    )}
                  />
                  Raw JSON
                </button>
                {rawOpen && (
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-surface-sunken p-3 font-mono text-[12px] text-text">
                    {JSON.stringify(testResult.raw_response, null, 2)}
                  </pre>
                )}
              </div>
            )}

            {!testMut.isPending && testResult && testResult.error && (
              <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
                <p className="font-sans text-[13px] font-medium text-danger">
                  {testResult.error}
                </p>
                <p className="mt-0.5 font-sans text-[12px] text-danger/80">
                  Check the URL, reply path, and that your endpoint is reachable.
                </p>
              </div>
            )}
          </Section>

          {/* Sticky footer */}
          <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-col gap-2 border-t border-border bg-surface-raised px-5 py-4">
            {(validationError ||
              saveMut.error instanceof Error) && (
              <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
                {validationError ? (
                  <p className="flex items-center gap-1.5 font-sans text-[13px] text-danger">
                    <X size={14} /> {validationError}
                  </p>
                ) : (
                  <p className="break-words font-sans text-[13px] text-danger">
                    {(() => {
                      const e = saveMut.error as Error & {
                        body?: { detail?: unknown };
                      };
                      const detail = e?.body?.detail;
                      return typeof detail === "string"
                        ? detail
                        : e?.message ?? "Save failed";
                    })()}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={saveMut.isPending || validationError != null}
                onClick={() => saveMut.mutate()}
              >
                {saveMut.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Section({
  title,
  children,
  first,
  titleExtra,
}: {
  title: string;
  children: React.ReactNode;
  first?: boolean;
  titleExtra?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 pb-4 pt-3.5",
        first ? "" : "border-t border-border",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-subtle">
          {title}
        </div>
        {titleExtra}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
  labelExtra,
  hint,
}: {
  label?: string;
  children: React.ReactNode;
  labelExtra?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <div className="flex items-center justify-between gap-2">
          <label className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
            {label}
          </label>
          {labelExtra}
        </div>
      )}
      {children}
      {hint && (
        <p className="font-sans text-[11px] leading-[16px] text-text-subtle">{hint}</p>
      )}
    </div>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-sunken/50 px-2.5 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-text-subtle">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
