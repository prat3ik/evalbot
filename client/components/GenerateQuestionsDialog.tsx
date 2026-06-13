"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Badge } from "@/components/ui/Badge";
import { API_BASE_URL, apiFetch, datasetsApi, type AiProvider, type Dataset } from "@/lib/api";
import { cn } from "@/lib/cn";

type Category = "factual" | "edge" | "adversarial" | "multi_hop";

interface GeneratedQ {
  id: string;
  question: string;
  expected_response: string | null;
  category: Category;
  expected_to_refuse: boolean;
  selected: boolean;
  editing: boolean;
}

const PROVIDER_OPTIONS: { label: string; value: AiProvider }[] = [
  { label: "Claude", value: "anthropic" },
  { label: "Gemini", value: "gemini" },
  { label: "OpenAI", value: "openai" },
  { label: "Ollama", value: "ollama" },
];

const CATEGORY_LIST: { value: Category; label: string }[] = [
  { value: "factual", label: "Factual" },
  { value: "edge", label: "Edge" },
  { value: "adversarial", label: "Adversarial" },
  { value: "multi_hop", label: "Multi-hop" },
];

const STAGE_LABEL: Record<string, string> = {
  reading_docs: "Reading your docs…",
  extracting: "Extracting topics…",
  probing: "Probing guidelines for adversarial cases…",
};

function categoryClasses(c: Category): { wrap: string; badge: string } {
  switch (c) {
    case "factual":
      return { wrap: "bg-info-soft border-info", badge: "bg-info text-white" };
    case "edge":
      return { wrap: "bg-warn-soft border-warn", badge: "bg-warn text-white" };
    case "adversarial":
      return { wrap: "bg-danger-soft border-danger", badge: "bg-danger text-white" };
    case "multi_hop":
      return { wrap: "bg-accent-soft border-accent", badge: "bg-accent text-accent-fg" };
  }
}

async function readSSE(
  res: Response,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal?.aborted) return;
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      let event = "message";
      let data = "";
      for (const l of lines) {
        if (l.startsWith("event:")) event = l.slice(6).trim();
        else if (l.startsWith("data:")) data += l.slice(5).trim();
      }
      if (data) onEvent(event, data);
    }
  }
}

export interface GenerateQuestionsDialogProps {
  projectId: string;
  currentDatasetId: string;
  onClose: () => void;
}

export function GenerateQuestionsDialog({
  projectId,
  currentDatasetId,
  onClose,
}: GenerateQuestionsDialogProps) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = React.useState<AiProvider>("openai");
  const [count, setCount] = React.useState<number>(20);
  const [selectedCats, setSelectedCats] = React.useState<Record<Category, boolean>>({
    factual: true,
    edge: true,
    adversarial: true,
    multi_hop: true,
  });

  const [stage, setStage] = React.useState<string | null>(null);
  const [streaming, setStreaming] = React.useState(false);
  const [items, setItems] = React.useState<GeneratedQ[]>([]);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);

  // Save panel
  const [savePanelOpen, setSavePanelOpen] = React.useState(false);
  const [saveMode, setSaveMode] = React.useState<"existing" | "new">("existing");
  const [saveDatasetId, setSaveDatasetId] = React.useState<string>(currentDatasetId);
  const [saveNewName, setSaveNewName] = React.useState<string>("");

  const datasetsQ = useQuery({
    queryKey: ["datasets", projectId],
    queryFn: () => datasetsApi.listByProject(projectId),
  });

  const closeAll = React.useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  const handleGenerate = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setItems([]);
    setStage(null);
    setErrorMsg(null);
    setDone(false);
    setStreaming(true);

    const cats = (Object.keys(selectedCats) as Category[]).filter((c) => selectedCats[c]);
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/projects/${projectId}/generate-questions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            count,
            categories: cats.length ? cats : null,
            provider,
          }),
          signal: ac.signal,
        },
      );
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setErrorMsg(`Server error: ${res.status} ${text || res.statusText}`);
        setStreaming(false);
        return;
      }
      await readSSE(
        res,
        (event, data) => {
          try {
            const obj = JSON.parse(data);
            if (event === "stage") {
              setStage(obj.stage);
            } else if (event === "question") {
              setItems((prev) => [
                {
                  id: `q-${Date.now()}-${prev.length}`,
                  question: String(obj.question || ""),
                  expected_response: obj.expected_response ?? null,
                  category: (obj.category as Category) || "factual",
                  expected_to_refuse: !!obj.expected_to_refuse,
                  selected: true,
                  editing: false,
                },
                ...prev,
              ]);
            } else if (event === "error") {
              setErrorMsg(String(obj.detail || "Provider error"));
            } else if (event === "done") {
              setDone(true);
              setStage(null);
            }
          } catch {
            /* ignore malformed lines */
          }
        },
        ac.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(`${(err as Error).name}: ${(err as Error).message}`);
      }
    } finally {
      setStreaming(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const selected = items.filter((i) => i.selected);
      const body: Record<string, unknown> = {
        questions: selected.map((i) => ({
          question: i.question,
          expected_response: i.expected_response,
          category: i.category,
          expected_to_refuse: i.expected_to_refuse,
          tags: [],
        })),
      };
      if (saveMode === "existing") {
        body.dataset_id = saveDatasetId;
      } else {
        body.dataset_name = saveNewName.trim();
      }
      return apiFetch<{ dataset_id: string; added: number }>(
        `/api/projects/${projectId}/generate-questions/save`,
        { method: "POST", body },
      );
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["datasets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dataset", r.dataset_id] });
      closeAll();
    },
  });

  const selectedCount = items.filter((i) => i.selected).length;
  const stageLabel = stage ? STAGE_LABEL[stage] ?? stage : null;

  return (
    <Dialog
      open
      onClose={closeAll}
      className="!w-[min(820px,calc(100vw-32px))] !max-w-none"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="font-serif text-[22px] font-medium leading-[30px] text-text flex items-center gap-2">
            <Sparkles size={18} className="text-accent" aria-hidden /> Generate Test Questions
          </h2>
          <p className="font-sans text-[13px] text-text-muted mt-1">
            AI drafts diverse test questions from your docs and guidelines.
          </p>
        </div>
        <button
          onClick={closeAll}
          className="text-text-muted hover:text-text"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      {/* Config row */}
      {!streaming && !done && items.length === 0 && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 font-sans text-[12px] text-text-muted">
              Provider
              <Select
                value={provider}
                onChange={(e) => setProvider(e.target.value as AiProvider)}
              >
                {PROVIDER_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 font-sans text-[12px] text-text-muted">
              Count
              <Select value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="30">30</option>
              </Select>
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-sans text-[12px] text-text-muted">Categories</span>
            <div className="flex flex-wrap gap-3">
              {CATEGORY_LIST.map((c) => (
                <label
                  key={c.value}
                  className="flex items-center gap-2 font-sans text-[13px] text-text"
                >
                  <input
                    type="checkbox"
                    checked={selectedCats[c.value]}
                    onChange={(e) =>
                      setSelectedCats((prev) => ({ ...prev, [c.value]: e.target.checked }))
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <Button onClick={handleGenerate}>
              <Sparkles size={14} aria-hidden /> Generate
            </Button>
          </div>
        </div>
      )}

      {/* Stage + streaming */}
      {(streaming || items.length > 0 || done) && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-sans text-[12px] text-text-muted min-h-[20px]">
              {stageLabel && (
                <span className="inline-flex items-center gap-2 rounded-md bg-surface-sunken px-2 py-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
                  {stageLabel}
                </span>
              )}
              {!stageLabel && streaming && (
                <span className="inline-flex items-center gap-2 rounded-md bg-surface-sunken px-2 py-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
                  Streaming…
                </span>
              )}
            </div>
            <div className="font-sans text-[12px] text-text-muted">
              {items.length} / {count} generated
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-md border border-danger bg-danger-soft p-3 font-sans text-[13px] text-text">
              {errorMsg}
              {/missing|API_KEY|credentials|not set/i.test(errorMsg) && (
                <a href="/settings" className="ml-2 underline text-accent">
                  Open Settings
                </a>
              )}
            </div>
          )}

          <div className="max-h-[40vh] overflow-y-auto flex flex-col gap-2 pr-1">
            {items.length === 0 && !errorMsg && (
              <div className="font-sans text-[13px] text-text-muted py-6 text-center">
                Waiting for the model…
              </div>
            )}
            {items.map((q, idx) => {
              const cc = categoryClasses(q.category);
              return (
                <div
                  key={q.id}
                  className={cn(
                    "rounded-md border p-2.5 flex items-start gap-2",
                    cc.wrap,
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={q.selected}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((p, i) =>
                          i === idx ? { ...p, selected: e.target.checked } : p,
                        ),
                      )
                    }
                  />
                  <div className="flex-1 min-w-0">
                    {q.editing ? (
                      <Textarea
                        value={q.question}
                        onChange={(e) =>
                          setItems((prev) =>
                            prev.map((p, i) =>
                              i === idx ? { ...p, question: e.target.value } : p,
                            ),
                          )
                        }
                        rows={2}
                      />
                    ) : (
                      <div className="font-sans text-[13px] text-text break-words">
                        {q.question}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-sans",
                          cc.badge,
                        )}
                      >
                        {q.category.replace("_", "-")}
                      </span>
                      {q.expected_to_refuse && (
                        <Badge>refuse</Badge>
                      )}
                    </div>
                  </div>
                  <button
                    className="text-text-muted hover:text-text"
                    onClick={() =>
                      setItems((prev) =>
                        prev.map((p, i) =>
                          i === idx ? { ...p, editing: !p.editing } : p,
                        ),
                      )
                    }
                    aria-label="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            {streaming && (
              <Button variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
            )}
            {done && !savePanelOpen && (
              <>
                <Button variant="ghost" onClick={closeAll}>
                  Discard
                </Button>
                <Button onClick={() => setSavePanelOpen(true)} disabled={selectedCount === 0}>
                  Save {selectedCount} selected to dataset
                </Button>
              </>
            )}
          </div>

          {savePanelOpen && (
            <div className="rounded-md border border-border bg-surface-sunken p-3 flex flex-col gap-2">
              <div className="font-sans text-[12px] text-text-muted">Add to</div>
              <div className="flex items-center gap-3 font-sans text-[13px]">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={saveMode === "existing"}
                    onChange={() => setSaveMode("existing")}
                  />
                  Existing dataset
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={saveMode === "new"}
                    onChange={() => setSaveMode("new")}
                  />
                  New dataset
                </label>
              </div>
              {saveMode === "existing" ? (
                <Select
                  value={saveDatasetId}
                  onChange={(e) => setSaveDatasetId(e.target.value)}
                >
                  {(datasetsQ.data ?? []).map((d: Dataset) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  placeholder="New dataset name"
                  value={saveNewName}
                  onChange={(e) => setSaveNewName(e.target.value)}
                />
              )}
              {saveMut.isError && (
                <div className="font-sans text-[12px] text-danger">
                  {(saveMut.error as Error).message}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setSavePanelOpen(false)}>
                  Back
                </Button>
                <Button
                  onClick={() => saveMut.mutate()}
                  disabled={
                    saveMut.isPending ||
                    (saveMode === "existing" && !saveDatasetId) ||
                    (saveMode === "new" && !saveNewName.trim())
                  }
                >
                  {saveMut.isPending ? "Saving…" : `Save ${selectedCount}`}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
