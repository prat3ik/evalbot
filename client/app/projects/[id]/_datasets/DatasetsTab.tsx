"use client";

import * as React from "react";
import Link from "next/link";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileDown, MessagesSquare, Plus, Pencil, Play, RefreshCw, Search, Upload, Trash2, X, Globe, Settings, Sparkles } from "lucide-react";

import { GenerateQuestionsDialog } from "@/components/GenerateQuestionsDialog";
import { DatasetRunHeatmap } from "@/components/DatasetRunHeatmap";

import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { DropZone } from "@/components/ui/DropZone";
import {
  api,
  API_BASE_URL,
  chatbotEndpointsApi,
  datasetsApi,
  type ChatTurn,
  type ChatbotEndpoint,
  type Dataset,
  type DatasetRow,
  type DatasetRowInput,
  type DatasetRun,
  type Project,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import { scoreBandClasses } from "@/lib/scoreColor";

function bandFg(score: number): string {
  return scoreBandClasses(score).fgClass;
}
function bandBg(score: number): string {
  return scoreBandClasses(score).bgClass;
}

const TAG_SUGGESTIONS = [
  "security",
  "prompt-injection",
  "harmfulness",
  "pii",
  "cultural",
  "factual",
  "support",
  "hallucination",
];

export function DatasetsTab({ project }: { project: Project }) {
  const projectId = project.id;
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);

  const openRunResults = React.useCallback(
    (runId: string) => {
      if (typeof window !== "undefined") {
        window.open(`/projects/${projectId}/runs/${runId}`, "_blank");
      }
    },
    [projectId],
  );

  const listQ = useQuery({
    queryKey: ["datasets", projectId],
    queryFn: () => datasetsApi.listByProject(projectId),
  });

  React.useEffect(() => {
    if (!selectedId && listQ.data && listQ.data.length > 0) {
      setSelectedId(listQ.data[0].id);
    }
  }, [listQ.data, selectedId]);

  const createMut = useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      datasetsApi.create(projectId, input),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ["datasets", projectId] });
      setSelectedId(d.id);
    },
  });

  const [newName, setNewName] = React.useState("");
  const [newOpen, setNewOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      {activeRunId && (
        <RunProgressStrip
          runId={activeRunId}
          onDismiss={() => setActiveRunId(null)}
          onShowResults={(id) => {
            openRunResults(id);
            setActiveRunId(null);
          }}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-[18px] leading-[26px] text-text">
          Datasets
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)] gap-4">
        {/* Left rail */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-sans text-[13px] font-medium uppercase tracking-[0.04em] text-text-muted">
              Datasets
            </h3>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus size={14} aria-hidden /> New
            </Button>
          </div>
          {listQ.isLoading && (
            <p className="font-sans text-[14px] text-text-muted">Loading…</p>
          )}
          {listQ.data && listQ.data.length === 0 && (
            <Card className="flex flex-col items-center gap-3 py-8 text-center">
              <h4 className="font-serif text-[18px] leading-[24px] text-text">
                No datasets yet
              </h4>
              <p className="font-sans text-[13px] text-text-muted max-w-[220px]">
                Create one to start batch-evaluating curated test cases.
              </p>
              <Button size="sm" onClick={() => setNewOpen(true)}>
                <Plus size={14} aria-hidden /> New
              </Button>
            </Card>
          )}
          <div className="flex flex-col gap-2">
            {(listQ.data ?? []).map((d) => (
              <DatasetCard
                key={d.id}
                dataset={d}
                active={d.id === selectedId}
                onClick={() => setSelectedId(d.id)}
              />
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="min-w-0">
          {selectedId ? (
            <DatasetDetail
              datasetId={selectedId}
              project={project}
              onRunStarted={(runId) => setActiveRunId(runId)}
              onOpenResults={(runId) => openRunResults(runId)}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <Card>
              <CardTitle>Select or create a dataset</CardTitle>
              <p className="mt-2 font-sans text-[14px] text-text-muted">
                Pick a dataset from the list, or start a new one.
              </p>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={newOpen} onClose={() => setNewOpen(false)} title="New dataset">
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Dataset name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim() || createMut.isPending}
              onClick={() => {
                createMut.mutate(
                  { name: newName.trim() },
                  {
                    onSuccess: () => {
                      setNewName("");
                      setNewOpen(false);
                    },
                  },
                );
              }}
            >
              Create
            </Button>
          </div>
        </div>
      </Dialog>

    </div>
  );
}

// ---------------- Left-rail card ----------------

function DatasetCard({
  dataset,
  active,
  onClick,
}: {
  dataset: Dataset;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-left rounded-lg border bg-surface p-3 transition-colors duration-fast ease-ev",
        active
          ? "border-accent ring-1 ring-accent/30"
          : "border-border hover:bg-surface-sunken",
      )}
    >
      <div className="font-sans text-[15px] font-semibold text-text truncate">
        {dataset.name}
      </div>
    </button>
  );
}

// ---------------- Detail panel ----------------

function DatasetDetail({
  datasetId,
  project,
  onRunStarted,
  onOpenResults,
  onDeleted,
}: {
  datasetId: string;
  project: Project;
  onRunStarted: (runId: string) => void;
  onOpenResults: (runId: string) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQ = useQuery({
    queryKey: ["dataset", datasetId],
    queryFn: () => datasetsApi.get(datasetId),
  });

  const [runOpen, setRunOpen] = React.useState(false);
  const [rowDialog, setRowDialog] = React.useState<
    | { mode: "create"; defaultTab?: "single" | "multi" }
    | { mode: "edit"; row: DatasetRow }
    | null
  >(null);
  const [editingDetails, setEditingDetails] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [descDraft, setDescDraft] = React.useState("");

  const updateMut = useMutation({
    mutationFn: (input: { name?: string; description?: string | null }) =>
      datasetsApi.update(datasetId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dataset", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["datasets", project.id] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => datasetsApi.delete(datasetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["datasets", project.id] });
      onDeleted();
    },
  });

  if (detailQ.isLoading || !detailQ.data) {
    return (
      <Card>
        <p className="font-sans text-[14px] text-text-muted">Loading dataset…</p>
      </Card>
    );
  }
  const d = detailQ.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editingDetails ? (
              <div className="flex flex-col gap-2">
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="Dataset name"
                  autoFocus
                  className="text-[18px]"
                />
                <Textarea
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  placeholder="Optional description — what this dataset is for, what it tests."
                  className="min-h-[60px]"
                />
                {updateMut.error instanceof Error && (
                  <p className="font-sans text-[12px] text-danger">
                    {updateMut.error.message}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={!nameDraft.trim() || updateMut.isPending}
                    onClick={() => {
                      updateMut.mutate(
                        {
                          name: nameDraft.trim(),
                          description: descDraft.trim() || null,
                        },
                        { onSuccess: () => setEditingDetails(false) },
                      );
                    }}
                  >
                    {updateMut.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingDetails(false)}
                    disabled={updateMut.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="group">
                <div className="flex items-center gap-2">
                  <h2 className="font-serif text-[22px] leading-[30px] text-text">
                    {d.name}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setNameDraft(d.name);
                      setDescDraft(d.description ?? "");
                      setEditingDetails(true);
                    }}
                    title="Edit name & description"
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-sans text-[12px] text-text-muted opacity-0 transition-opacity hover:bg-surface-sunken hover:text-text group-hover:opacity-100"
                  >
                    <Pencil size={12} aria-hidden /> Edit
                  </button>
                </div>
                {d.description ? (
                  <p className="mt-1 max-w-2xl font-sans text-[13px] leading-[18px] text-text-muted">
                    {d.description}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setNameDraft(d.name);
                      setDescDraft("");
                      setEditingDetails(true);
                    }}
                    className="mt-1 font-sans text-[12px] italic text-text-subtle hover:text-text-muted"
                  >
                    + Add a description
                  </button>
                )}
                <div className="mt-2 flex items-center gap-3 font-sans text-[13px] text-text-muted">
                  <span>{d.row_count} rows</span>
                  <LastRunIndicator
                    lastRun={d.last_run}
                    onView={(id) => onOpenResults(id)}
                  />
                </div>
                <div className="mt-1.5">
                  <ChatbotSourceChip project={project} />
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRowDialog({ mode: "create" })}
            >
              <Plus size={14} aria-hidden /> Add row
            </Button>
            <Button size="sm" onClick={() => setRunOpen(true)}>
              <Play size={14} aria-hidden /> Run
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (confirm("Delete this dataset and all its rows + runs?")) {
                  deleteMut.mutate();
                }
              }}
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          </div>
        </div>
      </Card>

      <RowsTable
        dataset={d}
        onAddRow={() => setRowDialog({ mode: "create" })}
        onEditRow={(row) => setRowDialog({ mode: "edit", row })}
      />

      <RunHistorySection
        datasetId={d.id}
        onView={(id) => onOpenResults(id)}
      />

      {runOpen && (
        <RunConfigDialog
          dataset={d}
          onClose={() => setRunOpen(false)}
          onStarted={(runId) => {
            setRunOpen(false);
            onRunStarted(runId);
            queryClient.invalidateQueries({ queryKey: ["datasets", project.id] });
          }}
        />
      )}

      {rowDialog && (
        <AddRowDialog
          dataset={d}
          row={rowDialog.mode === "edit" ? rowDialog.row : null}
          defaultTab={rowDialog.mode === "create" ? rowDialog.defaultTab : undefined}
          onClose={() => setRowDialog(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["dataset", d.id] });
            setRowDialog(null);
          }}
        />
      )}

    </div>
  );
}

// ---------------- Rows table ----------------

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,2fr)_minmax(0,2fr)_28px] items-start";

function RowsTable({
  dataset,
  onAddRow,
  onEditRow,
}: {
  dataset: Dataset;
  onAddRow?: () => void;
  onEditRow?: (row: DatasetRow) => void;
}) {
  const queryClient = useQueryClient();
  const rows = dataset.rows ?? [];

  // Row filtering ----------------------------------------------------------
  const [search, setSearch] = React.useState("");
  const [activeTags, setActiveTags] = React.useState<Set<string>>(new Set());
  const allTags = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const t of r.tags) s.add(t);
    return Array.from(s).sort();
  }, [rows]);
  const filteredRows = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (activeTags.size > 0 && !r.tags.some((t) => activeTags.has(t))) {
        return false;
      }
      if (!q) return true;
      return (
        r.question.toLowerCase().includes(q) ||
        (r.expected_response ?? "").toLowerCase().includes(q) ||
        (r.chatbot_response ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, search, activeTags]);
  const toggleTag = (t: string) =>
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const deleteMut = useMutation({
    mutationFn: (rowId: string) => datasetsApi.deleteRow(dataset.id, rowId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dataset", dataset.id] });
    },
  });

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Rows</CardTitle>
        {rows.length > 0 && (
          <span className="font-sans text-[12px] text-text-muted">
            {filteredRows.length === rows.length
              ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}`
              : `${filteredRows.length} of ${rows.length} rows`}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-3 rounded-md border border-dashed border-border bg-surface-sunken/30 py-10 text-center">
          <h4 className="font-serif text-[20px] leading-[26px] text-text">
            No rows yet
          </h4>
          <p className="font-sans text-[13px] text-text-muted max-w-[320px]">
            Add a single-turn question or a multi-turn chat as your first row.
          </p>
          {onAddRow && (
            <Button size="sm" onClick={onAddRow}>
              <Plus size={14} aria-hidden /> Add row
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 min-w-[200px]">
              <Search
                size={14}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search question, expected, or response…"
                className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-3 font-sans text-[13px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none focus:shadow-focus-ring"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {allTags.map((t) => {
                const active = activeTags.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTag(t)}
                    aria-pressed={active}
                    className={cn(
                      "inline-flex h-7 items-center rounded-md px-2 font-sans text-[11px] uppercase tracking-[0.04em] transition-colors duration-fast ease-ev",
                      active
                        ? "bg-accent text-accent-fg"
                        : "border border-border bg-surface text-text-muted hover:bg-surface-sunken",
                    )}
                  >
                    {t}
                  </button>
                );
              })}
              {activeTags.size > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTags(new Set())}
                  className="font-sans text-[12px] text-text-muted hover:text-text"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 overflow-x-auto rounded-md border border-border">
            <div className="min-w-[900px]">
              <div
                className={cn(
                  ROW_GRID,
                  "h-8 px-3 gap-2 bg-surface-sunken text-[11px] uppercase tracking-[0.04em] text-text-muted",
                )}
              >
                <div>#</div>
                <div>Question</div>
                <div>Tags</div>
                <div>Expected</div>
                <div>Chatbot resp.</div>
                <div className="text-right">·</div>
              </div>
              <div>
                {filteredRows.length === 0 ? (
                  <div className="px-3 py-6 text-center font-sans text-[13px] text-text-muted">
                    No rows match the current search or filters.
                  </div>
                ) : (
                  filteredRows.map((r) => (
                    <RowItem
                      key={r.id}
                      row={r}
                      onDelete={() => deleteMut.mutate(r.id)}
                      onEdit={onEditRow ? () => onEditRow(r) : undefined}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function RowItem({
  row,
  onDelete,
  onEdit,
}: {
  row: DatasetRow;
  onDelete: () => void;
  onEdit?: () => void;
}) {
  const isChat = (row.turns?.length ?? 0) > 0;
  return (
    <div className="group border-b border-border last:border-b-0">
      <div
        className={cn(
          ROW_GRID,
          "min-h-11 px-3 gap-2 py-1.5 hover:bg-surface-sunken transition-colors duration-fast ease-ev cursor-pointer",
        )}
        onClick={() => onEdit?.()}
      >
        <div className="font-mono text-[12px] text-text-muted pt-1">
          {row.position + 1}
        </div>
        <div className="min-w-0 pt-1">
          <div className="flex items-center gap-1.5">
            {isChat && (
              <Badge
                variant="info"
                className="h-[18px] px-1.5 text-[10px] inline-flex items-center gap-1"
              >
                <MessagesSquare size={10} aria-hidden />
                {row.turns.length} turn{row.turns.length === 1 ? "" : "s"}
              </Badge>
            )}
            <span
              className="truncate font-sans text-[14px] text-text"
              title={row.question}
            >
              {row.question}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 min-w-0">
          {row.tags.map((t) => (
            <Badge key={t} variant="info" className="h-[18px] px-1.5 text-[11px] max-w-full">
              <span className="truncate">{t}</span>
            </Badge>
          ))}
        </div>
        <div
          className="truncate font-sans text-[13px] text-text-muted pt-1"
          title={row.expected_response ?? ""}
        >
          {row.expected_response ?? "—"}
        </div>
        <div
          className="truncate font-sans text-[13px] pt-1 flex items-center gap-1.5 min-w-0"
          title={row.chatbot_response ?? "Fetched from the selected endpoint when this row runs."}
        >
          {row.chatbot_response ? (
            <span className="truncate text-text-muted">{row.chatbot_response}</span>
          ) : (
            <span className="italic text-text-subtle truncate">
              — from endpoint at run time
            </span>
          )}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            aria-label="Delete row"
            className="opacity-0 group-hover:opacity-100 transition-opacity duration-fast ease-ev inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-danger-soft hover:text-danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}


function LastRunIndicator({
  lastRun,
  onView,
}: {
  lastRun: Dataset["last_run"];
  onView: (id: string) => void;
}) {
  if (!lastRun) {
    return <span className="text-text-subtle">Never run</span>;
  }
  const passPct =
    lastRun.pass_rate != null ? Math.round(lastRun.pass_rate * 100) : null;
  const when = lastRun.started_at
    ? new Date(lastRun.started_at).toLocaleString()
    : null;
  return (
    <button
      type="button"
      onClick={() => onView(lastRun.id)}
      className="inline-flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-surface-sunken transition-colors duration-fast ease-ev"
      title="View last run"
    >
      <span className="text-text-muted">Last run</span>
      {lastRun.name && (
        <span className="font-sans text-[12px] text-text max-w-[200px] truncate">
          {lastRun.name}
        </span>
      )}
      {when && (
        <span className="font-mono text-[12px] text-text-subtle">{when}</span>
      )}
      {passPct != null ? (
        <span
          className={cn(
            "font-mono text-[12px] px-1.5 py-0.5 rounded-sm",
            bandFg(passPct),
            bandBg(passPct),
          )}
        >
          {passPct}%
        </span>
      ) : (
        <Badge variant="neutral">{lastRun.status}</Badge>
      )}
    </button>
  );
}

// ---------------- Unified add/edit row dialog (single + multi tabs) ----------------

type RowTab = "single" | "multi";

function AddRowDialog({
  dataset,
  row,
  defaultTab,
  onClose,
  onSaved,
}: {
  dataset: Dataset;
  row: DatasetRow | null;
  defaultTab?: RowTab;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = row !== null;
  const initialTab: RowTab =
    row && row.turns.length > 0 ? "multi" : defaultTab ?? "single";
  const [tab, setTab] = React.useState<RowTab>(initialTab);
  const initialTurns: ChatTurn[] = React.useMemo(() => {
    if (row && row.turns.length > 0) return row.turns;
    return [{ role: "user", content: "" }];
  }, [row]);
  const [turns, setTurns] = React.useState<ChatTurn[]>(initialTurns);
  const [singleQuestion, setSingleQuestion] = React.useState<string>(
    row && row.turns.length === 0 ? row.question : "",
  );
  const [expected, setExpected] = React.useState<string>(row?.expected_response ?? "");
  const [tagsInput, setTagsInput] = React.useState<string>(
    (row?.tags ?? []).join(", "),
  );
  const [chatbotSource, setChatbotSource] = React.useState<string>(
    row?.chatbot_source ?? "",
  );
  const [error, setError] = React.useState<string | null>(null);

  const endpointsQ = useQuery({
    queryKey: ["chatbot-endpoints", dataset.project_id],
    queryFn: () => chatbotEndpointsApi.list(dataset.project_id),
  });
  const endpoints: ChatbotEndpoint[] = endpointsQ.data ?? [];

  // Endpoint used while authoring a multi-turn row: derived from the chosen
  // `Chatbot source` (footer) so we don't double up controls. When the user
  // leaves it as "— Use run default —" we fall back to the project's default
  // endpoint so Fetch still works during authoring.
  const fetchEndpointId = React.useMemo(() => {
    if (chatbotSource.startsWith("endpoint:")) {
      return chatbotSource.slice("endpoint:".length);
    }
    const def = endpoints.find((e) => e.is_default) ?? endpoints[0];
    return def?.id ?? "";
  }, [chatbotSource, endpoints]);
  const fetchEndpointName = React.useMemo(
    () => endpoints.find((e) => e.id === fetchEndpointId)?.name ?? null,
    [endpoints, fetchEndpointId],
  );
  const [fetchingTurn, setFetchingTurn] = React.useState<number | null>(null);
  const [turnFetchError, setTurnFetchError] = React.useState<{
    index: number;
    message: string;
  } | null>(null);

  async function fetchAssistantTurn(turnIndex: number) {
    setTurnFetchError(null);
    if (!fetchEndpointId) {
      setTurnFetchError({ index: turnIndex, message: "Pick an endpoint first." });
      return;
    }
    // Find the most recent user message above this turn.
    let priorUser = "";
    for (let i = turnIndex - 1; i >= 0; i--) {
      if (turns[i]!.role === "user" && turns[i]!.content.trim()) {
        priorUser = turns[i]!.content.trim();
        break;
      }
    }
    if (!priorUser) {
      setTurnFetchError({
        index: turnIndex,
        message: "Add a user message above this turn first.",
      });
      return;
    }
    setFetchingTurn(turnIndex);
    try {
      const result = await chatbotEndpointsApi.test(fetchEndpointId, {
        question: priorUser,
      });
      if (result.error) {
        setTurnFetchError({ index: turnIndex, message: result.error });
      } else {
        updateTurn(turnIndex, { content: result.response_text || "" });
      }
    } catch (e) {
      setTurnFetchError({
        index: turnIndex,
        message: (e as Error).message,
      });
    } finally {
      setFetchingTurn(null);
    }
  }

  // "Generate" the expected response using the reference generator. For
  // multi-turn rows it generates an answer to the last user message; for
  // single-turn rows it uses the question field.
  const [generatingExpected, setGeneratingExpected] = React.useState(false);
  const [generateError, setGenerateError] = React.useState<string | null>(null);
  async function generateExpected() {
    setGenerateError(null);
    const question =
      tab === "multi" ? lastUserContent.trim() : singleQuestion.trim();
    if (!question) {
      setGenerateError(
        tab === "multi"
          ? "Add a user message first."
          : "Enter the test question first.",
      );
      return;
    }
    setGeneratingExpected(true);
    try {
      const r = await api.reference.generate(dataset.project_id, {
        question,
        forceRegenerate: true,
      });
      setExpected(r.answer || "");
    } catch (e) {
      setGenerateError((e as Error).message);
    } finally {
      setGeneratingExpected(false);
    }
  }

  const updateTurn = (i: number, patch: Partial<ChatTurn>) =>
    setTurns((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const moveTurn = (i: number, dir: -1 | 1) =>
    setTurns((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const removeTurn = (i: number) =>
    setTurns((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
  const addTurn = (role: "user" | "assistant") =>
    setTurns((prev) => [...prev, { role, content: "" }]);

  // The dataset run treats `question` as the last user turn so that the
  // chatbot endpoint's `{{question}}` resolves to it.
  const lastUserContent = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === "user") return turns[i]!.content;
    }
    return "";
  })();

  const saveMut = useMutation({
    mutationFn: () => {
      const tags = tagsInput
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const payload: DatasetRowInput =
        tab === "multi"
          ? {
              question: lastUserContent.trim(),
              expected_response: expected.trim() || null,
              chatbot_response: null,
              chatbot_source: chatbotSource || null,
              tags,
              turns: turns.map((t) => ({ role: t.role, content: t.content })),
            }
          : {
              question: singleQuestion.trim(),
              expected_response: expected.trim() || null,
              chatbot_response: null,
              chatbot_source: chatbotSource || null,
              tags,
              turns: [],
            };
      if (isEdit && row) return datasetsApi.updateRow(dataset.id, row.id, payload);
      return datasetsApi.addRow(dataset.id, payload);
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  // --- Run-this-row (single-row evaluation against chosen Chatbot source) ---
  const [runResult, setRunResult] = React.useState<{
    id: string;
    score: number | null;
    rationale: string | null;
  } | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [runPhase, setRunPhase] = React.useState<
    "idle" | "calling-bot" | "judging"
  >("idle");

  async function runThisRow() {
    setRunError(null);
    setRunResult(null);
    const q = (tab === "multi" ? lastUserContent : singleQuestion).trim();
    if (!q) {
      setRunError("Add a question (or user turn) first.");
      return;
    }
    if (!fetchEndpointId) {
      setRunError("No chatbot endpoint available. Pick a Chatbot source below.");
      return;
    }
    try {
      setRunPhase("calling-bot");
      const botRes = await chatbotEndpointsApi.test(fetchEndpointId, {
        question: q,
      });
      if (botRes.error) {
        setRunError(botRes.error);
        setRunPhase("idle");
        return;
      }
      const chatbotResponse = (botRes.response_text || "").trim();
      if (!chatbotResponse) {
        setRunError("Chatbot returned an empty response.");
        setRunPhase("idle");
        return;
      }
      setRunPhase("judging");
      const evalRes = await api.evaluate.run({
        project_id: dataset.project_id,
        question: q,
        chatbot_response: chatbotResponse,
        reference_answer: expected.trim() || null,
        method: "ai",
      });
      setRunResult({
        id: evalRes.id,
        score:
          evalRes.combined_score ??
          evalRes.ai_score ??
          null,
        rationale: evalRes.rationale ?? null,
      });
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunPhase("idle");
    }
  }

  const isRunning = runPhase !== "idle";

  const canSave =
    !saveMut.isPending &&
    (tab === "single"
      ? singleQuestion.trim() !== ""
      : turns.some((t) => t.role === "user" && t.content.trim() !== ""));

  const tabSwitch = (
    <div className="inline-flex rounded-md border border-border bg-surface-sunken p-0.5">
      {(
        [
          { key: "single", label: "Single Turn" },
          { key: "multi", label: "Multi-Turn Chat" },
        ] as const
      ).map((t) => {
        const active = tab === t.key;
        // When editing, lock the tab to the row's actual shape so we
        // can't silently drop turns or fabricate them.
        const disabled =
          isEdit &&
          ((row.turns.length > 0 && t.key === "single") ||
            (row.turns.length === 0 && t.key === "multi"));
        return (
          <button
            key={t.key}
            type="button"
            disabled={disabled}
            onClick={() => setTab(t.key)}
            aria-pressed={active}
            className={cn(
              "h-7 rounded-[6px] px-3 font-sans text-[13px] font-medium",
              "transition-colors duration-fast ease-ev",
              active
                ? "bg-surface-raised text-text shadow-elev-1"
                : "text-text-muted hover:text-text",
              disabled && "cursor-not-allowed opacity-40",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      className="w-[min(1180px,calc(100vw-32px))] max-w-none"
    >
      <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto pr-1">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-serif text-[22px] font-medium leading-[30px] text-text">
            {isEdit ? "Edit row" : "Add a dataset row"}
          </h2>
          {tabSwitch}
        </div>

        {tab === "single" ? null : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-sans text-[12px] leading-[16px] text-text-muted">
                  Author the conversation up to and including the latest user
                  turn. The bot's reply to that turn is what gets graded.
                </p>
                <span className="shrink-0 rounded-sm bg-surface-sunken px-1.5 py-0.5 font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  {turns.length} turn{turns.length === 1 ? "" : "s"}
                </span>
              </div>

              <ul className="flex flex-col gap-4 rounded-lg border border-border bg-surface-sunken/30 px-4 py-4">
                {fetchEndpointName && (
                  <li className="flex items-center gap-1.5 font-sans text-[11px] text-text-subtle">
                    <RefreshCw size={11} aria-hidden />
                    Fetch uses{" "}
                    <span className="font-semibold text-text-muted">
                      {fetchEndpointName}
                    </span>
                    {" — "}change in <em className="not-italic">Chatbot source</em> below.
                  </li>
                )}
                {turns.map((t, i) => {
                  const isUser = t.role === "user";
                  const isEmpty = t.content.trim() === "";
                  const isFetching = fetchingTurn === i;
                  const turnError =
                    turnFetchError?.index === i ? turnFetchError.message : null;
                  return (
                    <li
                      key={i}
                      className={cn(
                        "group/row flex w-full flex-col gap-1",
                        isUser ? "items-end" : "items-start",
                      )}
                    >
                      <div
                        className={cn(
                          "flex w-full",
                          isUser ? "justify-end" : "justify-start",
                        )}
                      >
                        <BubbleBox role={t.role} dashed={isEmpty}>
                          <AutoGrowTextarea
                            value={t.content}
                            onChange={(v) => updateTurn(i, { content: v })}
                            placeholder={
                              isUser
                                ? "Write the user message…"
                                : "Click Fetch to pull this turn from the endpoint — or type to override"
                            }
                          />
                        </BubbleBox>
                      </div>
                      <div
                        className={cn(
                          "flex items-center gap-2 px-1",
                          isUser ? "flex-row-reverse" : "flex-row",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            updateTurn(i, {
                              role: isUser ? "assistant" : "user",
                            })
                          }
                          className="font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted hover:text-text"
                          title="Toggle role"
                        >
                          {isUser ? "User" : "Assistant"}
                        </button>
                        {!isUser && (
                          <button
                            type="button"
                            onClick={() => fetchAssistantTurn(i)}
                            disabled={isFetching || !fetchEndpointId}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 py-0.5",
                              "font-sans text-[11px] text-text hover:bg-surface-sunken",
                              "disabled:cursor-not-allowed disabled:opacity-50",
                            )}
                            title="Fetch this turn from the endpoint using the prior user message"
                          >
                            <RefreshCw
                              size={10}
                              className={cn(isFetching && "animate-spin")}
                              aria-hidden
                            />
                            {isFetching
                              ? "Fetching…"
                              : isEmpty
                                ? "Fetch from endpoint"
                                : "Re-fetch"}
                          </button>
                        )}
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-ev group-hover/row:opacity-100">
                          <button
                            type="button"
                            aria-label="Move up"
                            onClick={() => moveTurn(i, -1)}
                            disabled={i === 0}
                            className="inline-flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-sunken disabled:opacity-30"
                          >
                            <ArrowUp size={11} aria-hidden />
                          </button>
                          <button
                            type="button"
                            aria-label="Move down"
                            onClick={() => moveTurn(i, 1)}
                            disabled={i === turns.length - 1}
                            className="inline-flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-sunken disabled:opacity-30"
                          >
                            <ArrowDown size={11} aria-hidden />
                          </button>
                          <button
                            type="button"
                            aria-label="Remove turn"
                            onClick={() => removeTurn(i)}
                            disabled={turns.length <= 1}
                            className="inline-flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
                          >
                            <Trash2 size={11} aria-hidden />
                          </button>
                        </div>
                      </div>
                      {turnError && (
                        <p className="px-1 font-sans text-[11px] text-danger">
                          {turnError}
                        </p>
                      )}
                    </li>
                  );
                })}

                <li className="flex items-center justify-center gap-2 pt-1">
                  <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-subtle">
                    Add
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => addTurn("user")}
                  >
                    <Plus size={12} aria-hidden /> user
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => addTurn("assistant")}
                  >
                    <Plus size={12} aria-hidden /> assistant
                  </Button>
                </li>
              </ul>
            </div>

            <div className="flex flex-col gap-4 lg:border-l lg:border-border lg:pl-5">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="font-sans text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted">
                    Expected response
                  </label>
                  <button
                    type="button"
                    onClick={generateExpected}
                    disabled={generatingExpected || !lastUserContent.trim()}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 py-0.5",
                      "font-sans text-[11px] text-text hover:bg-surface-sunken",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                    title="Generate from your documents using the AI judge"
                  >
                    <Sparkles
                      size={11}
                      className={cn(generatingExpected && "animate-pulse")}
                      aria-hidden
                    />
                    {generatingExpected ? "Generating…" : "Generate"}
                  </button>
                </div>
                <Textarea
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  rows={6}
                  placeholder="What the bot should say in response to the last user turn"
                  className="font-mono text-[13px]"
                />
                {generateError && (
                  <p className="font-sans text-[11px] text-danger">
                    {generateError}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "single" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className="font-sans text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted">
                  Test question
                </label>
                <Textarea
                  value={singleQuestion}
                  onChange={(e) => setSingleQuestion(e.target.value)}
                  rows={8}
                  placeholder="What's the bot being asked?"
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="font-sans text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted">
                    Expected response
                  </label>
                  <button
                    type="button"
                    onClick={generateExpected}
                    disabled={generatingExpected || !singleQuestion.trim()}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 py-0.5",
                      "font-sans text-[11px] text-text hover:bg-surface-sunken",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                    title="Generate from your documents using the AI judge"
                  >
                    <Sparkles
                      size={11}
                      className={cn(generatingExpected && "animate-pulse")}
                      aria-hidden
                    />
                    {generatingExpected ? "Generating…" : "Generate"}
                  </button>
                </div>
                <Textarea
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  rows={8}
                  placeholder="The ideal answer the bot should give"
                  className="font-mono text-[13px]"
                />
                {generateError && (
                  <p className="font-sans text-[11px] text-danger">
                    {generateError}
                  </p>
                )}
              </div>
            </div>

          </div>
        )}
      </div>

      {/* Sticky footer: metadata + actions in one tidy strip. */}
      <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 border-t border-border bg-surface-raised px-5 py-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-1 flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1">
              <label className="font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Tags
              </label>
              <Input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="safety, pii"
              />
            </div>
            <div className="flex min-w-[200px] flex-1 flex-col gap-1">
              <label className="font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Chatbot source
              </label>
              <Select
                selectSize="sm"
                value={chatbotSource}
                onChange={(e) => setChatbotSource(e.target.value)}
              >
                <option value="">— Use run default —</option>
                {endpoints.map((ep) => (
                  <option key={ep.id} value={`endpoint:${ep.id}`}>
                    {ep.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {(runResult || runError) && (
            <div className="rounded-md border border-border bg-surface-sunken/60 px-3 py-2 font-sans text-[12px] text-text">
              {runError ? (
                <span className="text-danger">{runError}</span>
              ) : runResult ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded-sm px-1.5 py-0.5 font-mono text-[12px]",
                        runResult.score != null
                          ? bandFg(runResult.score) + " " + bandBg(runResult.score)
                          : "bg-surface-raised text-text-muted",
                      )}
                    >
                      {runResult.score != null
                        ? `Score: ${Math.round(runResult.score)}`
                        : "Score: —"}
                    </span>
                    <span className="font-semibold">
                      {runResult.score != null && runResult.score >= 70
                        ? "PASS"
                        : "FAIL"}
                    </span>
                    <Link
                      href={`/evaluations/${runResult.id}`}
                      target="_blank"
                      className="ml-auto text-accent underline decoration-dotted underline-offset-2"
                    >
                      View full evaluation →
                    </Link>
                  </div>
                  {runResult.rationale && (
                    <p className="text-text-muted">{runResult.rationale}</p>
                  )}
                </div>
              ) : null}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            {(error || saveMut.error) && (
              <p className="mr-2 max-w-[280px] truncate font-sans text-[12px] text-danger">
                {error ??
                  (saveMut.error instanceof Error
                    ? saveMut.error.message
                    : "Save failed")}
              </p>
            )}
            <button
              type="button"
              onClick={runThisRow}
              disabled={isRunning}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-raised px-3 font-sans text-[12px] font-medium text-text hover:bg-surface-sunken disabled:opacity-60"
            >
              <Play size={12} aria-hidden />
              {runPhase === "calling-bot"
                ? "Calling bot…"
                : runPhase === "judging"
                  ? "Judging…"
                  : "Run this row"}
            </button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() => {
                setError(null);
                saveMut.mutate();
              }}
            >
              {saveMut.isPending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Add row"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------- Multi-turn editor primitives ----------------

/** Chat bubble container. Width is content-driven via a mirror element so it
 * grows in both directions until it hits the parent's max-width cap. */
function BubbleBox({
  role,
  dashed,
  children,
}: {
  role: "user" | "assistant";
  dashed?: boolean;
  children: React.ReactNode;
}) {
  const isUser = role === "user";
  return (
    <div
      className={cn(
        "relative w-fit min-w-[120px] max-w-[78%] rounded-2xl border px-3.5 py-2",
        isUser
          ? "rounded-br-md border-accent/30 bg-accent-soft"
          : "rounded-bl-md border-border bg-surface-raised",
        dashed && "border-dashed",
      )}
    >
      {children}
    </div>
  );
}

/** Textarea that grows with its content (no fixed rows, no scroll). Uses a
 * mirror div under-the-hood so the bubble container also widens to fit the
 * longest line. */
function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const display = value.length > 0 ? value : placeholder || " ";
  return (
    <div className="relative w-fit max-w-full">
      <div
        aria-hidden
        className="invisible whitespace-pre-wrap break-words pr-[1ch] font-sans text-[14px] leading-[22px]"
        style={{ minHeight: 22, minWidth: "10ch" }}
      >
        {display}
        {"\n"}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        className={cn(
          "absolute inset-0 block resize-none border-0 bg-transparent p-0",
          "font-sans text-[14px] leading-[22px] text-text placeholder:text-text-subtle",
          "focus:outline-none focus:ring-0",
          readOnly && "cursor-default",
        )}
        style={{ minHeight: 22 }}
      />
    </div>
  );
}

// ---------------- Run config dialog ----------------

function RunConfigDialog({
  dataset,
  onClose,
  onStarted,
}: {
  dataset: Dataset;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const method: "ml" | "ai" | "both" = "ai";
  const [provider, setProvider] = React.useState<string>("");
  const [tags, setTags] = React.useState<string[]>([]);
  const [endpointId, setEndpointId] = React.useState<string>("");
  const [name, setName] = React.useState<string>("");

  const endpointsQ = useQuery({
    queryKey: ["chatbot-endpoints", dataset.project_id],
    queryFn: () => chatbotEndpointsApi.list(dataset.project_id),
  });

  React.useEffect(() => {
    if (!endpointId && endpointsQ.data && endpointsQ.data.length > 0) {
      const def = endpointsQ.data.find((e) => e.is_default) ?? endpointsQ.data[0];
      setEndpointId(def.id);
    }
  }, [endpointsQ.data, endpointId]);

  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    (dataset.rows ?? []).forEach((r) => r.tags.forEach((t) => set.add(t)));
    TAG_SUGGESTIONS.forEach((t) => set.add(t));
    return Array.from(set).sort();
  }, [dataset]);

  const runMut = useMutation({
    mutationFn: () =>
      datasetsApi.run(dataset.id, {
        method,
        ai_provider: provider || null,
        tag_filter: tags,
        chatbot_endpoint_id: endpointId || null,
        name: name.trim() || null,
      }),
    onSuccess: (run) => onStarted(run.id),
  });

  const endpoints = endpointsQ.data ?? [];

  return (
    <Dialog open onClose={onClose} title="Run dataset">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="font-sans text-[13px] font-medium text-text uppercase tracking-[0.04em]">
            Run name (optional)
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Smoke v3 — post-auth-rewrite"
          />
          <p className="font-sans text-[12px] text-text-muted">
            Helps identify this run later in lists and on evaluation pages.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="font-sans text-[13px] font-medium text-text uppercase tracking-[0.04em]">
            Chatbot source
          </label>
          <p className="font-sans text-[12px] text-text-muted">
            Rows with a manual <code>chatbot_response</code> always use it. Rows
            without one are fetched from the selected endpoint.
          </p>
          {endpoints.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-2 font-sans text-[12px] text-text-muted">
              No endpoints configured — manual responses only. Add one in
              Settings.
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
                  {ep.is_default ? " (default)" : ""} — {ep.url}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="font-sans text-[13px] font-medium text-text uppercase tracking-[0.04em]">
            Judge AI Provider
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
          <p className="font-sans text-[12px] leading-[16px] text-text-muted">
            The LLM that grades the chatbot&rsquo;s response. Use a different
            provider for the chatbot endpoint.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="font-sans text-[13px] font-medium text-text uppercase tracking-[0.04em]">
            Tag filter (optional)
          </label>
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((t) => {
              const on = tags.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    setTags((cur) =>
                      cur.includes(t)
                        ? cur.filter((x) => x !== t)
                        : [...cur, t],
                    )
                  }
                  className={cn(
                    "px-2 py-1 rounded-sm font-sans text-[12px]",
                    on
                      ? "bg-accent text-accent-fg"
                      : "bg-surface-sunken text-text-muted",
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
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
            {runMut.isPending ? "Starting…" : "Run"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------- Import dialog ----------------

function ImportDialog({
  datasetId,
  onClose,
  onDone,
}: {
  datasetId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [result, setResult] = React.useState<{ imported: number; errors: string[] } | null>(
    null,
  );
  const importMut = useMutation({
    mutationFn: (file: File) => datasetsApi.importFile(datasetId, file),
    onSuccess: (r) => {
      setResult(r);
      onDone();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Import rows">
      <div className="flex flex-col gap-3">
        <p className="font-sans text-[13px] text-text-muted">
          CSV columns: question, expected_response, chatbot_response, tags
          (comma-separated), category. Or a JSON array of row objects.
        </p>
        <DropZone
          accept=".csv,.json"
          multiple={false}
          onFiles={(files) => {
            if (files[0]) importMut.mutate(files[0]);
          }}
        />
        {importMut.error instanceof Error && (
          <p className="font-sans text-[13px] text-danger">
            {importMut.error.message}
          </p>
        )}
        {result && (
          <div className="font-sans text-[13px] text-text-muted">
            Imported {result.imported}. Errors: {result.errors.length}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------- Run progress strip ----------------

function RunProgressStrip({
  runId,
  onDismiss,
  onShowResults,
}: {
  runId: string;
  onDismiss: () => void;
  onShowResults: (runId: string) => void;
}) {
  const q = useQuery<DatasetRun>({
    queryKey: ["dataset-run", runId],
    queryFn: () => datasetsApi.getRun(runId),
    refetchInterval: (data) => {
      const r = (data as unknown as { state?: { data?: DatasetRun } })?.state
        ?.data;
      const status = r?.status ?? "pending";
      return status === "pending" || status === "running" ? 1000 : false;
    },
  });
  const cancelMut = useMutation({
    mutationFn: () => datasetsApi.cancelRun(q.data!.dataset_id, runId),
  });

  if (!q.data) return null;
  const r = q.data;
  const pct =
    r.total_rows > 0 ? Math.round((r.completed_rows / r.total_rows) * 100) : 0;
  const done =
    r.status === "completed" ||
    r.status === "failed" ||
    r.status === "cancelled";
  return (
    <div className="rounded-lg border border-accent bg-accent-soft p-3 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 font-sans text-[13px]">
          <span className="text-accent-pressed font-semibold uppercase tracking-[0.04em]">
            Run {r.status}
          </span>
          <span className="font-mono text-[12px] text-text-muted">
            {r.completed_rows} / {r.total_rows}
          </span>
        </div>
        <div className="mt-2 h-2 bg-surface-sunken rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-base ease-ev"
            style={{ width: `${pct}%` }}
          />
        </div>
        {r.error && (
          <p className="mt-1 font-sans text-[12px] text-danger">{r.error}</p>
        )}
      </div>
      <div className="flex gap-2">
        {!done && (
          <Button size="sm" variant="secondary" onClick={() => cancelMut.mutate()}>
            Cancel
          </Button>
        )}
        {done && (
          <Button size="sm" onClick={() => onShowResults(runId)}>
            View results
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <X size={14} aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function ViewToggle({
  value,
  onChange,
}: {
  value: "heatmap" | "table";
  onChange: (v: "heatmap" | "table") => void;
}) {
  const opts: Array<{ key: "heatmap" | "table"; label: string }> = [
    { key: "heatmap", label: "Heatmap" },
    { key: "table", label: "Table" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-raised p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            "px-2.5 py-1 font-sans text-[12px] rounded-[5px] transition-colors",
            value === o.key
              ? "bg-accent text-white"
              : "text-text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function RunSummarySection({ run }: { run: DatasetRun }) {
  const s = run.summary;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile
        label="Avg combined"
        value={s?.avg_combined != null ? s.avg_combined.toFixed(1) : "—"}
        tone={s?.avg_combined ?? null}
      />
      <Tile
        label="Pass rate"
        value={s?.pass_rate != null ? `${Math.round(s.pass_rate * 100)}%` : "—"}
        tone={s?.pass_rate != null ? s.pass_rate * 100 : null}
      />
      <Tile
        label="Total queries"
        value={String(s?.total_rows ?? run.total_rows)}
        tone={null}
      />
      <Tile
        label="Total tokens"
        value={new Intl.NumberFormat("en-US").format(s?.total_tokens ?? 0)}
        tone={null}
      />
    </div>
  );
}

export function RunByTagBreakdown({ run }: { run: DatasetRun }) {
  const s = run.summary;
  return (
    <BreakdownTable
      title="By tag"
      rows={(s?.by_tag ?? []).map((t) => ({
        key: t.tag,
        count: t.count,
        avg: t.avg_combined,
        pass: t.pass_rate,
      }))}
    />
  );
}

export function RunResultsContent({ run }: { run: DatasetRun }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Queries</CardTitle>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full font-sans text-[13px]">
            <thead>
              <tr className="text-left border-b border-border">
                <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Question
                </th>
                <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Tags
                </th>
                <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                  Score
                </th>
                <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                  Tokens
                </th>
                <th className="py-2 px-2" />
              </tr>
            </thead>
            <tbody>
              {run.items.map((it) => (
                <tr key={it.id} className="border-t border-border align-top">
                  <td className="py-2 px-2 max-w-md">
                    <div className="line-clamp-2 text-text">
                      {it.question ?? "—"}
                    </div>
                    {it.error && (
                      <div className="font-sans text-[12px] text-danger mt-1">
                        {it.error}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex flex-wrap gap-1">
                      {it.tags.map((t) => (
                        <Badge key={t} variant="info">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  {(() => {
                    const s = it.ai_score ?? it.combined_score;
                    return (
                      <td
                        className={cn(
                          "py-2 px-2 font-mono text-right",
                          s != null ? bandFg(s) : "text-text-muted",
                        )}
                      >
                        {s != null ? s.toFixed(1) : "—"}
                      </td>
                    );
                  })()}
                  <td className="py-2 px-2 text-right font-mono tabular-nums text-text-muted">
                    {(() => {
                      const t =
                        it.total_tokens ??
                        ((it.judge_total_tokens ?? 0) +
                          (it.reference_total_tokens ?? 0) +
                          (it.chatbot_total_tokens ?? 0));
                      return t ? new Intl.NumberFormat("en-US").format(t) : "—";
                    })()}
                  </td>
                  <td className="py-2 px-2">
                    {it.evaluation_id && (
                      <Link
                        href={`/evaluations/${it.evaluation_id}`}
                        className="text-accent-pressed underline font-sans text-[12px]"
                      >
                        View
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: number | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4">
      <div className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-serif text-[28px] leading-9",
          tone != null ? bandFg(tone) : "text-text",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; count: number; avg: number | null; pass: number | null }[];
}) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-full font-sans text-[13px]">
          <thead>
            <tr className="text-left border-b border-border">
              <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                Name
              </th>
              <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                Count
              </th>
              <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                Avg combined
              </th>
              <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                Pass rate
              </th>
              <th className="py-2 px-2 text-[11px] uppercase tracking-[0.04em] text-text-muted w-32">
                Bar
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const passPct = r.pass != null ? Math.round(r.pass * 100) : 0;
              return (
                <tr key={r.key} className="border-t border-border">
                  <td className="py-2 px-2">{r.key}</td>
                  <td className="py-2 px-2 font-mono text-right">{r.count}</td>
                  <td
                    className={cn(
                      "py-2 px-2 font-mono text-right",
                      r.avg != null ? bandFg(r.avg) : "text-text-muted",
                    )}
                  >
                    {r.avg != null ? r.avg.toFixed(1) : "—"}
                  </td>
                  <td className="py-2 px-2 font-mono text-right">
                    {r.pass != null ? `${passPct}%` : "—"}
                  </td>
                  <td className="py-2 px-2">
                    <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${passPct}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------- Chatbot source indicator ----------------

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

function openConfiguration(projectId: string) {
  // page.tsx owns the Next router; it listens for this event and switches to
  // the Configuration tab.
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("evalbot:open-tab", {
      detail: { projectId, tab: "configuration" },
    }),
  );
}

function ChatbotSourceChip({ project }: { project: Project }) {
  const q = useQuery({
    queryKey: ["chatbot-endpoints", project.id],
    queryFn: () => chatbotEndpointsApi.list(project.id),
  });
  const endpoints: ChatbotEndpoint[] = q.data ?? [];
  if (endpoints.length === 0) {
    return (
      <p className="font-sans text-[12px] text-text-muted">
        Manual chatbot responses ·{" "}
        <button
          type="button"
          className="text-accent-pressed underline hover:text-accent"
          onClick={() => openConfiguration(project.id)}
        >
          Add endpoint
        </button>
      </p>
    );
  }
  const def = endpoints.find((e) => e.is_default) ?? endpoints[0];
  return (
    <button
      type="button"
      onClick={() => openConfiguration(project.id)}
      title={`Default: ${def.method} ${def.url}`}
      className="inline-flex max-w-full items-center gap-2 rounded-sm border border-border bg-surface-sunken/60 px-2 py-1 font-sans text-[12px] text-text-muted hover:bg-surface-sunken transition-colors duration-fast ease-ev"
    >
      <Globe size={12} aria-hidden className="shrink-0 text-text-muted" />
      <span className="inline-flex h-[16px] items-center rounded-sm bg-accent-soft px-1 font-semibold uppercase tracking-[0.04em] text-[10px] text-accent-pressed">
        Endpoints
      </span>
      <span className="font-sans text-[12px]">
        {endpoints.length} configured
      </span>
      <span className="text-text-subtle">·</span>
      <span className="truncate font-mono text-[12px]">
        {def.name} default
      </span>
      <Settings size={12} aria-hidden className="shrink-0 text-text-subtle" />
    </button>
  );
}

export function RunSourceIndicator({ run }: { run: DatasetRun }) {
  if (!run.chatbot_endpoint_id) {
    return (
      <p className="font-sans text-[12px] text-text-muted">
        Source: <span className="italic">Manual responses</span>
      </p>
    );
  }
  return (
    <p className="font-sans text-[12px] text-text-muted">
      Source: <span className="font-medium text-text">{run.chatbot_endpoint_name ?? "endpoint"}</span>{" "}
      <span className="font-mono text-text-muted">
        (POST {run.chatbot_endpoint_url ?? ""})
      </span>
    </p>
  );
}

// ---------------- Run history ----------------

function RunHistorySection({
  datasetId,
  onView,
}: {
  datasetId: string;
  onView: (runId: string) => void;
}) {
  const q = useQuery<DatasetRun[]>({
    queryKey: ["dataset-runs", datasetId],
    queryFn: () => datasetsApi.runsByDataset(datasetId),
    // Auto-refresh while any run is pending/running so the table updates
    // without a page refresh while a run is in flight.
    refetchInterval: (data) => {
      const list = (data as unknown as { state?: { data?: DatasetRun[] } })
        ?.state?.data;
      const inFlight = (list ?? []).some(
        (r) => r.status === "pending" || r.status === "running",
      );
      return inFlight ? 2000 : false;
    },
  });

  const runs = q.data ?? [];

  return (
    <Card>
      <CardTitle>Run history</CardTitle>
      {q.isLoading ? (
        <p className="mt-2 font-sans text-[14px] text-text-muted">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="mt-3 font-serif text-[15px] leading-[22px] text-text-muted">
          No runs yet
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-md border border-border">
          <table className="min-w-full font-sans text-[13px]">
            <thead>
              <tr className="bg-surface-sunken text-left">
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Name
                </th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Started
                </th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Status
                </th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted">
                  Endpoint
                </th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                  Rows
                </th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                  Avg combined
                </th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-text-muted text-right">
                  Pass rate
                </th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const avg = r.summary?.avg_combined ?? null;
                const passRate = r.summary?.pass_rate ?? null;
                return (
                  <tr key={r.id} className="border-t border-border align-middle">
                    <td
                      className="px-3 py-2 text-text max-w-[220px] truncate"
                      title={r.name ?? "(unnamed)"}
                    >
                      {r.name || (
                        <span className="italic text-text-subtle">unnamed</span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 text-text"
                      title={new Date(r.started_at).toLocaleString()}
                    >
                      {relativeTime(r.started_at)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                    </td>
                    <td
                      className="px-3 py-2 font-sans text-[12px] text-text-muted truncate max-w-[180px]"
                      title={r.chatbot_endpoint_url ?? "Manual responses only"}
                    >
                      {r.chatbot_endpoint_name ?? (
                        <span className="italic text-text-subtle">manual</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-right tabular-nums">
                      {r.completed_rows}/{r.total_rows}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 font-mono text-right tabular-nums",
                        avg != null ? bandFg(avg) : "text-text-muted",
                      )}
                    >
                      {avg != null ? avg.toFixed(1) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-right tabular-nums">
                      {passRate != null
                        ? `${Math.round(passRate * 100)}%`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="text-accent-pressed underline font-sans text-[12px] hover:text-accent"
                        onClick={() => onView(r.id)}
                      >
                        View
                      </button>
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

function statusVariant(
  status: string,
): "success" | "danger" | "warn" | "accent" | "neutral" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "warn";
  if (status === "running" || status === "pending") return "accent";
  return "neutral";
}

