"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { cn } from "@/lib/cn";
import { ApiError, chatbotEndpointsApi, datasetsApi } from "@/lib/api";

const CREATE_NEW_SENTINEL = "__create_new__";

const TAG_SUGGESTIONS = [
  "factual",
  "security",
  "support",
  "hallucination",
  "cultural",
];

export interface SaveToDatasetDialogProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  defaultValues: {
    question: string;
    expected_response: string;
    chatbot_response: string;
    tags?: string[];
    category?: string;
    /** When provided + non-empty, saves a multi-turn chat row. */
    turns?: { role: "user" | "assistant"; content: string }[];
  };
}

export function SaveToDatasetDialog({
  projectId,
  open,
  onClose,
  defaultValues,
}: SaveToDatasetDialogProps) {
  const qc = useQueryClient();

  const datasetsQ = useQuery({
    queryKey: ["datasets", projectId],
    queryFn: () => datasetsApi.listByProject(projectId),
    enabled: open,
  });

  const [datasetId, setDatasetId] = React.useState<string>("");
  const [newDatasetName, setNewDatasetName] = React.useState<string>("");
  const [question, setQuestion] = React.useState<string>("");
  const [expected, setExpected] = React.useState<string>("");
  const [chatbot, setChatbot] = React.useState<string>("");
  const [tags, setTags] = React.useState<string[]>([]);
  const [tagDraft, setTagDraft] = React.useState<string>("");
  const [category, setCategory] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedTo, setSavedTo] = React.useState<string | null>(null);

  // "Chatbot response" source: paste manually, or fetch from a configured endpoint.
  const [chatbotSource, setChatbotSource] = React.useState<"manual" | "endpoint">(
    "manual",
  );
  const [endpointId, setEndpointId] = React.useState<string>("");
  const [fetching, setFetching] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);

  const endpointsQ = useQuery({
    queryKey: ["chatbot-endpoints", projectId],
    queryFn: () => chatbotEndpointsApi.list(projectId),
    enabled: open,
  });

  // Pre-select the project's default endpoint once the list loads.
  React.useEffect(() => {
    if (!open || endpointId) return;
    const list = endpointsQ.data;
    if (!list || list.length === 0) return;
    const def = list.find((e) => e.is_default) ?? list[0];
    setEndpointId(def.id);
  }, [open, endpointId, endpointsQ.data]);

  // Reset state on open / when defaults change.
  React.useEffect(() => {
    if (!open) return;
    setQuestion(defaultValues.question ?? "");
    setExpected(defaultValues.expected_response ?? "");
    setChatbot(defaultValues.chatbot_response ?? "");
    setTags(defaultValues.tags ?? []);
    setCategory(defaultValues.category ?? "");
    setTagDraft("");
    setNewDatasetName("");
    setSubmitting(false);
    setError(null);
    setSavedTo(null);
    setChatbotSource("manual");
    setFetching(false);
    setFetchError(null);
    // Don't reset datasetId — sticky across re-opens within a session is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Default-select first dataset once loaded.
  React.useEffect(() => {
    if (!open) return;
    if (datasetId) return;
    const list = datasetsQ.data;
    if (!list) return;
    if (list.length === 0) {
      setDatasetId(CREATE_NEW_SENTINEL);
    } else {
      setDatasetId(list[0]!.id);
    }
  }, [open, datasetId, datasetsQ.data]);

  function commitTagDraft() {
    const parts = tagDraft
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) return;
    setTags((cur) => {
      const set = new Set(cur);
      for (const p of parts) set.add(p);
      return Array.from(set);
    });
    setTagDraft("");
  }

  function removeTag(t: string) {
    setTags((cur) => cur.filter((x) => x !== t));
  }

  function addSuggestion(t: string) {
    setTags((cur) => (cur.includes(t) ? cur : [...cur, t]));
  }

  async function fetchFromEndpoint() {
    setFetchError(null);
    if (!endpointId) {
      setFetchError("Pick an endpoint first.");
      return;
    }
    if (!question.trim()) {
      setFetchError("Enter a question first — it's sent to the endpoint.");
      return;
    }
    setFetching(true);
    try {
      const result = await chatbotEndpointsApi.test(endpointId, {
        question: question.trim(),
      });
      if (result.error) {
        setFetchError(result.error);
      } else {
        setChatbot(result.response_text || "");
      }
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? ((e.body as { detail?: string } | null)?.detail ?? e.message)
          : (e as Error).message;
      setFetchError(msg);
    } finally {
      setFetching(false);
    }
  }

  const isCreateNew = datasetId === CREATE_NEW_SENTINEL;
  const canSubmit =
    !submitting &&
    question.trim().length > 0 &&
    (isCreateNew ? newDatasetName.trim().length > 0 : datasetId.length > 0);

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      let targetId = datasetId;
      let targetName = "";
      if (isCreateNew) {
        const created = await datasetsApi.create(projectId, {
          name: newDatasetName.trim(),
        });
        targetId = created.id;
        targetName = created.name;
      } else {
        targetName =
          datasetsQ.data?.find((d) => d.id === targetId)?.name ?? "dataset";
      }
      const turns = defaultValues.turns ?? [];
      await datasetsApi.addRow(targetId, {
        question: question.trim(),
        expected_response: expected || null,
        chatbot_response: chatbot || null,
        tags,
        category: category.trim() ? category.trim() : null,
        turns: turns.length > 0 ? turns : [],
      });
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
      setSavedTo(targetName);
      window.setTimeout(() => {
        setSavedTo(null);
        onClose();
      }, 800);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? (() => {
              const body = e.body as { detail?: string } | null;
              return body?.detail ?? e.message;
            })()
          : (e as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save to dataset"
      className="w-[min(560px,calc(100vw-32px))]"
    >
      <div className="flex flex-col gap-4">
        <Field label="Pick a dataset">
          <Select
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            disabled={datasetsQ.isLoading}
          >
            {datasetsQ.isLoading && <option value="">Loading…</option>}
            {(datasetsQ.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value={CREATE_NEW_SENTINEL}>+ Create new dataset</option>
          </Select>
          {isCreateNew && (
            <div className="mt-2">
              <Input
                autoFocus
                value={newDatasetName}
                onChange={(e) => setNewDatasetName(e.target.value)}
                placeholder="New dataset name"
              />
            </div>
          )}
        </Field>

        <Field label="Question">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="The question evaluated"
          />
        </Field>

        <Field label="Expected response">
          <Textarea
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            placeholder="The reference / ground-truth answer"
            className="min-h-[80px]"
          />
        </Field>

        <Field label="Chatbot response">
          <div className="mb-2 inline-flex rounded-md border border-border bg-surface-raised p-0.5 self-start">
            {(
              [
                { key: "manual", label: "Manual paste" },
                { key: "endpoint", label: "Fetch from endpoint" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setChatbotSource(opt.key)}
                className={cn(
                  "px-2.5 py-1 font-sans text-[12px] rounded-[5px] transition-colors",
                  chatbotSource === opt.key
                    ? "bg-accent text-white"
                    : "text-text-muted hover:text-text",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {chatbotSource === "endpoint" && (
            <div className="mb-2 flex flex-col gap-2">
              <div className="flex items-stretch gap-2">
                <Select
                  value={endpointId}
                  onChange={(e) => setEndpointId(e.target.value)}
                  disabled={endpointsQ.isLoading || fetching}
                  className="flex-1"
                >
                  {endpointsQ.isLoading && (
                    <option value="">Loading endpoints…</option>
                  )}
                  {!endpointsQ.isLoading &&
                    (endpointsQ.data ?? []).length === 0 && (
                      <option value="">No endpoints configured</option>
                    )}
                  {(endpointsQ.data ?? []).map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.name}
                      {ep.is_default ? " (default)" : ""} — {ep.url}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={fetchFromEndpoint}
                  disabled={
                    fetching ||
                    !endpointId ||
                    !question.trim() ||
                    (endpointsQ.data ?? []).length === 0
                  }
                >
                  {fetching ? "Fetching…" : "Fetch"}
                </Button>
              </div>
              {fetchError && (
                <div
                  role="alert"
                  className="rounded-md border border-danger bg-danger-soft px-3 py-1.5 font-sans text-[12px] text-danger"
                >
                  {fetchError}
                </div>
              )}
            </div>
          )}
          <Textarea
            value={chatbot}
            onChange={(e) => setChatbot(e.target.value)}
            placeholder={
              chatbotSource === "endpoint"
                ? "Click Fetch to autofill from the endpoint — editable after."
                : "The chatbot's actual response"
            }
            className="min-h-[80px]"
          />
        </Field>

        <Field label="Tags">
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised px-2 py-1.5">
            {tags.map((t) => (
              <Badge
                key={t}
                variant="accent"
                className="inline-flex items-center gap-1 normal-case"
              >
                {t}
                <button
                  type="button"
                  onClick={() => removeTag(t)}
                  aria-label={`Remove ${t}`}
                  className="ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-sm hover:bg-accent-pressed/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  commitTagDraft();
                } else if (
                  e.key === "Backspace" &&
                  tagDraft === "" &&
                  tags.length > 0
                ) {
                  setTags((cur) => cur.slice(0, -1));
                }
              }}
              onBlur={commitTagDraft}
              placeholder={
                tags.length === 0 ? "Type and press Enter or comma" : ""
              }
              className={cn(
                "min-w-[140px] flex-1 border-0 bg-transparent p-0 px-1 py-0.5",
                "font-sans text-[13px] text-text placeholder:text-text-subtle",
                "focus:outline-none focus:ring-0",
              )}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-subtle">
              Suggestions:
            </span>
            {TAG_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addSuggestion(s)}
                disabled={tags.includes(s)}
                className={cn(
                  "rounded-sm border border-border px-1.5 py-0.5",
                  "font-sans text-[11px] text-text-muted",
                  "hover:bg-surface-sunken hover:text-text",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </Field>


        {error && (
          <div
            role="alert"
            className="rounded-md border border-danger bg-danger-soft px-3 py-2 font-sans text-[12px] text-danger"
          >
            {error}
          </div>
        )}

        {savedTo && (
          <div
            role="status"
            className="rounded-md border border-success bg-success-soft px-3 py-2 font-sans text-[13px] text-success"
          >
            Saved to {savedTo} ✓
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? "Saving…" : "Save row"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <label className="mb-1 font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
