"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Markdown } from "@/components/ui/Markdown";
import { Select } from "@/components/ui/Select";
import {
  api,
  type AiProvider,
  type Document,
  type GuidelineFile,
  type BuildGuidelinesEvent,
  type BuildGuidelinesFileEvent,
  type IngestUrlEvent,
  type IngestUrlFileEvent,
  type IngestUrlPageEvent,
  type IngestUrlPlanEvent,
  type Project,
} from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

const DOC_ACCEPT = ".md,.txt";
const GUIDELINE_ACCEPT = ".md";

type BrowserTab = "documents" | "guidelines";

export function OverviewTab({ project }: { project: Project }) {
  const [tab, setTab] = React.useState<BrowserTab>("documents");

  const documentsQuery = useQuery({
    queryKey: ["documents", project.id],
    queryFn: () => api.documents.list(project.id),
  });
  const guidelinesQuery = useQuery({
    queryKey: ["guidelines", project.id],
    queryFn: () => api.guidelines.list(project.id),
  });

  const docCount = documentsQuery.data?.length ?? 0;
  const guidelineCount = guidelinesQuery.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <InfoRow
        project={project}
        docCount={docCount}
        guidelineCount={guidelineCount}
      />
      <Card>
        <TabStrip
          tab={tab}
          onChange={setTab}
          docCount={docCount}
          guidelineCount={guidelineCount}
        />
        <div className="mt-3">
          {tab === "documents" ? (
            <DocumentsTabPanel projectId={project.id} />
          ) : (
            <GuidelinesTabPanel projectId={project.id} />
          )}
        </div>
      </Card>
    </div>
  );
}

function InfoRow({
  project,
  docCount,
  guidelineCount,
}: {
  project: Project;
  docCount: number;
  guidelineCount: number;
}) {
  return (
    <div className="flex flex-col gap-2">
      {project.description && (
        <p className="font-sans text-[13px] leading-[18px] text-text-muted">
          {project.description}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <StatChip
          icon={<FileText size={12} aria-hidden />}
          value={docCount}
          label="docs"
        />
        <StatChip
          icon={<ShieldCheck size={12} aria-hidden />}
          value={guidelineCount}
          label="guidelines"
        />
        <StatChip
          icon={<span aria-hidden>·</span>}
          value={relativeTime(project.created_at)}
          label="created"
          mono={false}
        />
      </div>
    </div>
  );
}

function StatChip({
  icon,
  value,
  label,
  mono = true,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 font-sans text-[12px] text-text-muted">
      <span className="text-text-subtle">{icon}</span>
      <span className={mono ? "font-mono tabular-nums text-text" : "text-text"}>
        {value}
      </span>
      <span className="text-text-muted">{label}</span>
    </span>
  );
}

function TabStrip({
  tab,
  onChange,
  docCount,
  guidelineCount,
}: {
  tab: BrowserTab;
  onChange: (t: BrowserTab) => void;
  docCount: number;
  guidelineCount: number;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-border">
      <TabButton
        active={tab === "documents"}
        onClick={() => onChange("documents")}
        label="Documents"
        count={docCount}
      />
      <TabButton
        active={tab === "guidelines"}
        onClick={() => onChange("guidelines")}
        label="Guidelines"
        count={guidelineCount}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex h-7 items-center gap-1.5 px-1 font-sans text-[13px] transition-colors duration-fast ease-ev ${
        active ? "text-text" : "text-text-muted hover:text-text"
      }`}
      aria-pressed={active}
    >
      <span>{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-text-subtle">
        ({count})
      </span>
      {active && (
        <span
          aria-hidden
          className="absolute -bottom-px left-0 right-0 h-[2px] bg-accent"
        />
      )}
    </button>
  );
}

interface PendingUpload {
  key: string;
  filename: string;
  error?: string;
}

function useUploadQueue() {
  const [pending, setPending] = React.useState<PendingUpload[]>([]);
  const add = React.useCallback((files: File[]) => {
    const items = files.map((f) => ({
      key: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: f.name,
    }));
    setPending((prev) => [...prev, ...items]);
    return items;
  }, []);
  const remove = React.useCallback((key: string) => {
    setPending((prev) => prev.filter((p) => p.key !== key));
  }, []);
  const setError = React.useCallback((key: string, error: string) => {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, error } : p)));
  }, []);
  return { pending, add, remove, setError };
}

// ---------------- Documents tab ----------------

function DocumentsTabPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { pending, add, remove, setError } = useUploadQueue();
  const [query, setQuery] = React.useState("");
  const [urlOpen, setUrlOpen] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const documentsQuery = useQuery({
    queryKey: ["documents", projectId],
    queryFn: () => api.documents.list(projectId),
  });

  const uploadMutation = useMutation({
    mutationFn: async (args: { file: File; key: string }) => {
      try {
        const res = await api.documents.upload(projectId, args.file);
        return { key: args.key, res };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setError(args.key, message);
        throw err;
      }
    },
    onSuccess: ({ key }) => {
      remove(key);
      queryClient.invalidateQueries({ queryKey: ["documents", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => api.documents.delete(projectId, documentId),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["documents", projectId] });
      setExpandedId((cur) => (cur === id ? null : cur));
    },
  });

  const handleFiles = (files: File[]) => {
    const items = add(files);
    items.forEach((item, i) => {
      uploadMutation.mutate({ file: files[i], key: item.key });
    });
  };

  const docs: Document[] = documentsQuery.data ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? docs.filter((d) => d.filename.toLowerCase().includes(q) || d.path.toLowerCase().includes(q))
    : docs;
  const isEmpty = docs.length === 0 && pending.length === 0;
  const expanded = docs.find((d) => d.id === expandedId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${docs.length} documents…`}
            className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 font-sans text-[13px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none focus:shadow-focus-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 font-sans text-[13px] font-medium text-text hover:bg-surface-sunken"
        >
          <Upload size={14} aria-hidden /> Upload
        </button>
        <button
          type="button"
          onClick={() => setUrlOpen((v) => !v)}
          aria-pressed={urlOpen}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-3 font-sans text-[13px] font-medium ${
            urlOpen
              ? "border border-accent bg-accent-soft text-accent-pressed"
              : "border border-border bg-surface text-text hover:bg-surface-sunken"
          }`}
        >
          <Globe size={14} aria-hidden /> From URL
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={DOC_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) handleFiles(files);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {urlOpen && <UrlIngestRow projectId={projectId} />}

      {isEmpty ? (
        <EmptyState
          icon={<FileText size={20} aria-hidden />}
          label="No documents yet"
          hint="Use Upload or From URL above to add reference docs."
        />
      ) : filtered.length === 0 && pending.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-6 text-center">
          <p className="font-sans text-[13px] text-text-muted">
            No documents match “{query}”.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {pending.map((p) => (
            <PendingCard key={p.key} item={p} />
          ))}
          {filtered.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              active={doc.id === expandedId}
              onOpen={() =>
                setExpandedId((prev) => (prev === doc.id ? null : doc.id))
              }
              onDelete={() => deleteMutation.mutate(doc.id)}
              deleting={
                deleteMutation.isPending && deleteMutation.variables === doc.id
              }
            />
          ))}
        </div>
      )}

      {expanded && (
        <DocumentPreviewPane
          projectId={projectId}
          doc={expanded}
          onClose={() => setExpandedId(null)}
        />
      )}
    </div>
  );
}

function DocumentPreviewPane({
  projectId,
  doc,
  onClose,
}: {
  projectId: string;
  doc: Document;
  onClose: () => void;
}) {
  const isUrl = doc.path.startsWith("http://") || doc.path.startsWith("https://");
  const contentQ = useQuery({
    queryKey: ["document-content", projectId, doc.id],
    queryFn: () => api.documents.content(projectId, doc.id),
  });
  const previewText = contentQ.data?.content ?? null;

  return (
    <div className="rounded-md border border-border bg-surface-sunken">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileText size={14} className="shrink-0 text-text-muted" aria-hidden />
          <span className="truncate font-sans text-[13px] text-text" title={doc.filename}>
            {doc.filename}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isUrl && (
            <a
              href={doc.path}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-sans text-[12px] text-text-muted hover:bg-surface hover:text-text"
            >
              <ExternalLink size={12} aria-hidden /> Open
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-sans text-[12px] text-text-muted hover:bg-surface hover:text-text"
          >
            <X size={12} aria-hidden /> Close
          </button>
        </div>
      </div>
      {contentQ.isLoading ? (
        <div className="px-3 py-4 font-sans text-[13px] text-text-muted">Loading…</div>
      ) : contentQ.isError ? (
        <div className="px-3 py-4 font-sans text-[13px] text-danger">
          Could not load preview:{" "}
          {contentQ.error instanceof Error ? contentQ.error.message : "unknown error"}
        </div>
      ) : previewText ? (
        <>
          {isUrl && (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-sans text-[11px] text-text-muted">
              <span>{contentQ.data?.distilled ? "AI-distilled from" : "Source:"}</span>
              <a
                href={doc.path}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-text-muted underline hover:text-text"
              >
                {doc.path}
              </a>
              {contentQ.data?.distilled && (
                <span
                  title="Distilled by Smart extract"
                  className="inline-flex items-center rounded-sm bg-accent-soft px-1 font-sans text-[10px] uppercase tracking-[0.04em] text-accent-pressed"
                >
                  AI
                </span>
              )}
            </div>
          )}
          <div className="max-h-[480px] overflow-auto px-4 py-3">
            <Markdown source={previewText} />
          </div>
        </>
      ) : isUrl ? (
        <div className="px-3 py-4">
          <p className="mb-2 font-sans text-[13px] text-text-muted">
            This page was ingested from a URL but no extracted text was cached.
            Open it in a new tab to view the original page:
          </p>
          <a
            href={doc.path}
            target="_blank"
            rel="noreferrer"
            className="break-all font-mono text-[12px] text-accent-pressed underline"
          >
            {doc.path}
          </a>
        </div>
      ) : (
        <div className="px-3 py-4 font-sans text-[13px] italic text-text-subtle">
          (empty)
        </div>
      )}
    </div>
  );
}

function DocumentCard({
  doc,
  active,
  onOpen,
  onDelete,
  deleting,
}: {
  doc: Document;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const failed = Boolean(doc.indexing_error);
  const indexed = !failed && Boolean(doc.indexed_at);
  const statusBadge = failed ? (
    <Badge variant="danger">Failed</Badge>
  ) : indexed ? (
    <Badge variant="success">Ready</Badge>
  ) : (
    <Badge variant="warn">Indexing…</Badge>
  );
  const isUrl = doc.path.startsWith("http://") || doc.path.startsWith("https://");
  const isConsolidated = doc.path.startsWith("consolidated://");

  return (
    <div
      className={`group relative flex min-w-0 items-center gap-2 rounded-md border p-3 transition-colors duration-fast ease-ev ${
        active
          ? "border-accent bg-accent-soft/40"
          : "border-border bg-surface-raised hover:bg-surface-sunken"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={active}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {isConsolidated ? (
          <Sparkles size={16} className="shrink-0 text-accent" aria-hidden />
        ) : isUrl ? (
          <Globe size={16} className="shrink-0 text-text-muted" aria-hidden />
        ) : (
          <FileText size={16} className="shrink-0 text-text-muted" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-sans text-[13px] text-text" title={doc.filename}>
            {doc.filename}
          </span>
          <div className="flex items-center justify-between gap-1">
            {statusBadge}
            {indexed && doc.indexed_at && (
              <span className="font-sans text-[11px] text-text-subtle">
                {relativeTime(doc.indexed_at)}
              </span>
            )}
          </div>
          {failed && doc.indexing_error && (
            <p className="line-clamp-2 font-sans text-[11px] leading-[14px] text-danger">
              {doc.indexing_error}
            </p>
          )}
        </div>
      </button>
      <button
        type="button"
        aria-label={`Delete ${doc.filename}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        disabled={deleting}
        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded text-text-muted opacity-0 transition-opacity duration-fast ease-ev hover:bg-danger-soft hover:text-danger group-hover:opacity-100 disabled:opacity-50"
      >
        <Trash2 size={12} aria-hidden />
      </button>
    </div>
  );
}

function PendingCard({ item }: { item: PendingUpload }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-sunken/50 p-3">
      <FileText size={16} className="shrink-0 text-text-muted" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-sans text-[13px] text-text">
          {item.filename}
        </span>
        {item.error ? (
          <Badge variant="danger">Failed</Badge>
        ) : (
          <Badge variant="neutral">Uploading…</Badge>
        )}
      </div>
    </div>
  );
}

// ---------------- Guidelines tab ----------------

function GuidelinesTabPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { pending, add, remove, setError } = useUploadQueue();
  const [query, setQuery] = React.useState("");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [building, setBuilding] = React.useState(false);
  const [buildStatus, setBuildStatus] = React.useState<string>("");
  const [buildFiles, setBuildFiles] = React.useState<BuildGuidelinesFileEvent[]>(
    [],
  );
  const [buildError, setBuildError] = React.useState<string | null>(null);
  const [buildDone, setBuildDone] = React.useState(false);
  const buildAbortRef = React.useRef<AbortController | null>(null);

  const handleBuild = async () => {
    setBuilding(true);
    setBuildStatus("");
    setBuildFiles([]);
    setBuildError(null);
    setBuildDone(false);
    const ctrl = new AbortController();
    buildAbortRef.current = ctrl;
    try {
      await api.guidelines.build(
        projectId,
        {},
        (ev: BuildGuidelinesEvent) => {
          if (ev.type === "status") {
            setBuildStatus(ev.message);
          } else if (ev.type === "file") {
            setBuildFiles((prev) => [...prev, ev]);
          } else if (ev.type === "done") {
            setBuildStatus(
              `Saved ${ev.files_saved} of ${ev.files_attempted} guideline files.`,
            );
            setBuildDone(true);
            queryClient.invalidateQueries({ queryKey: ["guidelines", projectId] });
          } else if (ev.type === "error") {
            setBuildError(ev.message);
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setBuildError(err instanceof Error ? err.message : "Build failed");
      }
    } finally {
      setBuilding(false);
      buildAbortRef.current = null;
    }
  };

  const cancelBuild = () => buildAbortRef.current?.abort();

  const guidelinesQuery = useQuery({
    queryKey: ["guidelines", projectId],
    queryFn: () => api.guidelines.list(projectId),
  });

  const uploadMutation = useMutation({
    mutationFn: async (args: { file: File; key: string }) => {
      try {
        const res = await api.guidelines.upload(projectId, args.file);
        return { key: args.key, res };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setError(args.key, message);
        throw err;
      }
    },
    onSuccess: ({ key }) => {
      remove(key);
      queryClient.invalidateQueries({ queryKey: ["guidelines", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (guidelineId: string) => api.guidelines.delete(projectId, guidelineId),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["guidelines", projectId] });
      setExpandedId((cur) => (cur === id ? null : cur));
    },
  });

  const handleFiles = (files: File[]) => {
    const items = add(files);
    items.forEach((item, i) => {
      uploadMutation.mutate({ file: files[i], key: item.key });
    });
  };

  const guidelines: GuidelineFile[] = guidelinesQuery.data ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? guidelines.filter(
        (g) =>
          g.filename.toLowerCase().includes(q) || g.content.toLowerCase().includes(q),
      )
    : guidelines;
  const isEmpty = guidelines.length === 0 && pending.length === 0;
  const expanded = guidelines.find((g) => g.id === expandedId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${guidelines.length} guideline${
              guidelines.length === 1 ? "" : "s"
            }…`}
            className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 font-sans text-[13px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none focus:shadow-focus-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 font-sans text-[13px] font-medium text-text hover:bg-surface-sunken"
        >
          <Upload size={14} aria-hidden /> Upload
        </button>
        <button
          type="button"
          onClick={handleBuild}
          disabled={building}
          title="Read indexed documents and draft guideline files with AI"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-3 font-sans text-[13px] font-medium text-accent-pressed hover:bg-accent-soft/70 disabled:opacity-60"
        >
          {building ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Sparkles size={14} aria-hidden />
          )}
          Generate with AI
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={GUIDELINE_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) handleFiles(files);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {(building || buildDone || buildError || buildFiles.length > 0) && (
        <div className="rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 font-sans text-[12px] text-text-muted">
              {building && (
                <Loader2 size={12} className="animate-spin text-accent" aria-hidden />
              )}
              {buildDone && !buildError && (
                <CheckCircle2 size={12} className="text-success" aria-hidden />
              )}
              <span className="truncate">
                {buildError || buildStatus || "Reading indexed documents…"}
              </span>
            </div>
            {building && (
              <button
                type="button"
                onClick={cancelBuild}
                className="font-sans text-[12px] text-text-muted hover:text-text"
              >
                Cancel
              </button>
            )}
          </div>
          {buildFiles.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {buildFiles.map((f, i) => (
                <BuildFileRow key={i} file={f} />
              ))}
            </ul>
          )}
        </div>
      )}

      {isEmpty ? (
        <EmptyState
          icon={<ShieldCheck size={20} aria-hidden />}
          label="No guidelines yet"
          hint="Click Upload to add .md files. The AI judge reads them verbatim."
        />
      ) : filtered.length === 0 && pending.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-6 text-center">
          <p className="font-sans text-[13px] text-text-muted">
            No guidelines match “{query}”.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {pending.map((p) => (
            <PendingCard key={p.key} item={p} />
          ))}
          {filtered.map((g) => (
            <GuidelineCard
              key={g.id}
              guideline={g}
              active={g.id === expandedId}
              onToggle={() =>
                setExpandedId((prev) => (prev === g.id ? null : g.id))
              }
              onDelete={() => deleteMutation.mutate(g.id)}
              deleting={
                deleteMutation.isPending && deleteMutation.variables === g.id
              }
            />
          ))}
        </div>
      )}

      {expanded && (
        <GuidelinePreviewPane
          projectId={projectId}
          guideline={expanded}
          onClose={() => setExpandedId(null)}
        />
      )}
    </div>
  );
}

function GuidelinePreviewPane({
  projectId,
  guideline,
  onClose,
}: {
  projectId: string;
  guideline: GuidelineFile;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(guideline.content);

  React.useEffect(() => {
    if (!editing) setDraft(guideline.content);
  }, [guideline.content, editing]);

  const saveMut = useMutation({
    mutationFn: () => api.guidelines.update(projectId, guideline.id, draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guidelines", projectId] });
      setEditing(false);
    },
  });

  return (
    <div className="rounded-md border border-border bg-surface-sunken">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={14} className="shrink-0 text-text-muted" aria-hidden />
          <span className="truncate font-sans text-[13px] text-text" title={guideline.filename}>
            {guideline.filename}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(guideline.content);
                }}
                disabled={saveMut.isPending}
                className="inline-flex h-7 items-center rounded-md px-2 font-sans text-[12px] text-text-muted hover:bg-surface hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => saveMut.mutate()}
                disabled={saveMut.isPending || draft === guideline.content}
                className="inline-flex h-7 items-center rounded-md bg-accent px-2.5 font-sans text-[12px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(guideline.content);
                setEditing(true);
              }}
              className="inline-flex h-7 items-center rounded-md px-2 font-sans text-[12px] text-text-muted hover:bg-surface hover:text-text"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-sans text-[12px] text-text-muted hover:bg-surface hover:text-text"
          >
            <X size={12} aria-hidden /> Close
          </button>
        </div>
      </div>
      {editing ? (
        <div className="px-3 py-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-[280px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-[13px] leading-5 text-text focus:border-accent focus:outline-none focus:shadow-focus-ring"
          />
          {saveMut.error instanceof Error && (
            <p className="mt-2 font-sans text-[13px] text-danger">
              {saveMut.error.message}
            </p>
          )}
        </div>
      ) : (
        <div className="max-h-[420px] overflow-auto px-4 py-3">
          {guideline.content ? (
            <Markdown source={guideline.content} />
          ) : (
            <p className="font-sans text-[13px] italic text-text-subtle">(empty file)</p>
          )}
        </div>
      )}
    </div>
  );
}

function GuidelineCard({
  guideline,
  active,
  onToggle,
  onDelete,
  deleting,
}: {
  guideline: GuidelineFile;
  active: boolean;
  onToggle: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className={`group relative flex min-w-0 items-center gap-2 rounded-md border p-3 transition-colors duration-fast ease-ev ${
        active
          ? "border-accent bg-accent-soft/40"
          : "border-border bg-surface-raised hover:bg-surface-sunken"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={active}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <ShieldCheck
          size={16}
          className="shrink-0 text-text-muted"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className="truncate font-sans text-[13px] text-text"
            title={guideline.filename}
          >
            {guideline.filename}
          </span>
          <Badge variant="success">Ready</Badge>
        </div>
      </button>
      <button
        type="button"
        aria-label={`Delete ${guideline.filename}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        disabled={deleting}
        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded text-text-muted opacity-0 transition-opacity duration-fast ease-ev hover:bg-danger-soft hover:text-danger group-hover:opacity-100 disabled:opacity-50"
      >
        <Trash2 size={12} aria-hidden />
      </button>
    </div>
  );
}

// ---------------- Empty state ----------------

function EmptyState({
  icon,
  label,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <span className="text-text-subtle">{icon}</span>
      <p className="font-serif text-[16px] text-text">{label}</p>
      <p className="max-w-xs font-sans text-[12px] leading-[16px] text-text-muted">
        {hint}
      </p>
    </div>
  );
}

// ---------------- URL ingest row ----------------

type IngestPhase = "input" | "discovering" | "selecting" | "ingesting" | "done";

function UrlIngestRow({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = React.useState("");
  const [phase, setPhase] = React.useState<IngestPhase>("input");
  const [discovered, setDiscovered] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [status, setStatus] = React.useState<string>("");
  const [pages, setPages] = React.useState<IngestUrlPageEvent[]>([]);
  const [plan, setPlan] = React.useState<IngestUrlPlanEvent | null>(null);
  const [files, setFiles] = React.useState<IngestUrlFileEvent[]>([]);
  const [writingSlug, setWritingSlug] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [smartExtract, setSmartExtract] = React.useState(true);
  const [provider, setProvider] = React.useState<AiProvider>("anthropic");
  const abortRef = React.useRef<AbortController | null>(null);

  const reset = () => {
    setPhase("input");
    setDiscovered([]);
    setSelected(new Set());
    setStatus("");
    setPages([]);
    setPlan(null);
    setFiles([]);
    setWritingSlug(null);
    setError(null);
  };

  const handleDiscover = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setPhase("discovering");
    setStatus("Looking for sitemap…");
    try {
      const res = await api.documents.discoverUrls(projectId, trimmed, 100);
      if (!res.urls.length) {
        setError("Could not find any pages at this URL.");
        setPhase("input");
        return;
      }
      setDiscovered(res.urls);
      setSelected(new Set(res.urls.slice(0, 20))); // sensible default
      setStatus(`Found ${res.urls.length} page${res.urls.length === 1 ? "" : "s"}.`);
      setPhase("selecting");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discovery failed");
      setPhase("input");
    }
  };

  const handleIngest = async () => {
    if (selected.size === 0) return;
    const urls = discovered.filter((u) => selected.has(u));
    setPages([]);
    setPlan(null);
    setFiles([]);
    setWritingSlug(null);
    setStatus("");
    setError(null);
    setPhase("ingesting");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await api.documents.ingestUrl(
        projectId,
        {
          url: url.trim(),
          urls,
          max_pages: urls.length,
          smart_extract: smartExtract,
          provider: smartExtract ? provider : undefined,
        },
        (ev: IngestUrlEvent) => {
          if (ev.type === "status") {
            setStatus(ev.message);
          } else if (ev.type === "page_progress") {
            // legacy per-page distillation progress (only fires when
            // smart_extract is off in the old code path — kept for safety)
          } else if (ev.type === "page") {
            setPages((prev) => [...prev, ev]);
          } else if (ev.type === "plan") {
            setPlan(ev);
            setStatus(
              `Plan: ${ev.files.length} consolidated file${
                ev.files.length === 1 ? "" : "s"
              } from ${ev.pages_seen} page${ev.pages_seen === 1 ? "" : "s"}.`,
            );
          } else if (ev.type === "file_progress") {
            setWritingSlug(ev.slug);
            setStatus(`Writing ${ev.title}…`);
          } else if (ev.type === "file") {
            setWritingSlug(null);
            setFiles((prev) => [...prev, ev]);
          } else if (ev.type === "done") {
            setWritingSlug(null);
            if (typeof ev.files_saved === "number") {
              setStatus(
                `Saved ${ev.files_saved} file${
                  ev.files_saved === 1 ? "" : "s"
                } from ${ev.pages_indexed} page${
                  ev.pages_indexed === 1 ? "" : "s"
                }.`,
              );
            } else {
              setStatus(
                `Indexed ${ev.pages_indexed} page${
                  ev.pages_indexed === 1 ? "" : "s"
                }.`,
              );
            }
            setPhase("done");
            queryClient.invalidateQueries({ queryKey: ["documents", projectId] });
          } else if (ev.type === "error") {
            setError(ev.message);
            setPhase("selecting");
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Ingest failed");
      }
      setPhase("selecting");
    } finally {
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const toggle = (u: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });
  const selectAll = () => setSelected(new Set(discovered));
  const selectNone = () => setSelected(new Set());

  const isBusy = phase === "discovering" || phase === "ingesting";

  return (
    <div className="rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Globe size={14} className="shrink-0 text-text-muted" aria-hidden />
          <span className="font-sans text-[13px] text-text-muted">Ingest from a docs URL</span>
        </div>
        {phase !== "input" && (
          <button
            type="button"
            onClick={reset}
            className="font-sans text-[12px] text-text-muted hover:text-text"
          >
            Start over
          </button>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (phase === "selecting") handleIngest();
          else handleDiscover();
        }}
        className="mt-2 flex min-w-0 gap-2"
      >
        <div className="min-w-0 flex-1">
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.example.com"
            disabled={phase !== "input"}
            required
          />
        </div>
        {phase === "input" && (
          <Button type="submit" variant="primary" size="md" disabled={!url.trim()}>
            Find pages
          </Button>
        )}
        {phase === "discovering" && (
          <Button type="button" variant="secondary" size="md" disabled>
            <Loader2 size={14} className="animate-spin" aria-hidden /> Searching…
          </Button>
        )}
        {phase === "selecting" && (
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={selected.size === 0}
          >
            Ingest {selected.size} page{selected.size === 1 ? "" : "s"}
          </Button>
        )}
        {phase === "ingesting" && (
          <Button type="button" variant="secondary" size="md" onClick={handleCancel}>
            Cancel
          </Button>
        )}
        {phase === "done" && (
          <Button type="button" variant="secondary" size="md" onClick={reset}>
            Ingest another
          </Button>
        )}
      </form>

      {(status || isBusy) && (
        <div className="mt-2 flex items-center gap-2 font-sans text-[12px] text-text-muted">
          {isBusy && (
            <Loader2 size={12} className="animate-spin text-accent" aria-hidden />
          )}
          {phase === "done" && (
            <CheckCircle2 size={12} className="text-success" aria-hidden />
          )}
          <span className="truncate">{status}</span>
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-1.5 font-sans text-[13px] leading-[18px] text-danger">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {phase === "selecting" && (
        <>
          <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={smartExtract}
                onChange={(e) => setSmartExtract(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-sans text-[13px] font-medium text-text">
                  Smart extract (AI distillation)
                </span>
                <span className="font-sans text-[12px] leading-[16px] text-text-muted">
                  Use AI to pull canonical facts, examples, and caveats from each
                  page before indexing. Slower (~1 call/page) but produces cleaner
                  ground truth.
                </span>
              </div>
            </label>
            {smartExtract && (
              <div className="mt-2 flex items-center gap-2 pl-[22px]">
                <span className="font-sans text-[12px] text-text-muted">Provider</span>
                <div className="w-[160px]">
                  <Select
                    selectSize="sm"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as AiProvider)}
                  >
                    <option value="anthropic">Claude</option>
                    <option value="gemini">Gemini</option>
                    <option value="openai">OpenAI</option>
                    <option value="ollama">Ollama</option>
                  </Select>
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 rounded-md border border-border bg-surface">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span className="font-sans text-[12px] text-text-muted">
                {selected.size} of {discovered.length} selected
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  className="font-sans text-[12px] text-accent-pressed hover:underline"
                >
                  Select all
                </button>
                <span className="text-text-subtle">·</span>
                <button
                  type="button"
                  onClick={selectNone}
                  className="font-sans text-[12px] text-text-muted hover:text-text"
                >
                  Clear
                </button>
              </div>
            </div>
            <ul className="max-h-[260px] overflow-auto px-2 py-1.5">
              {discovered.map((u) => (
                <SitemapRow
                  key={u}
                  url={u}
                  checked={selected.has(u)}
                  onToggle={() => toggle(u)}
                />
              ))}
            </ul>
          </div>
        </>
      )}

      {(phase === "ingesting" || phase === "done") && pages.length > 0 && (
        <details className="mt-2 rounded-md border border-border bg-surface">
          <summary className="cursor-pointer select-none px-3 py-2 font-sans text-[12px] text-text-muted hover:text-text">
            Fetched pages ({pages.length})
          </summary>
          <ul className="max-h-[200px] overflow-auto px-2 py-1.5">
            {pages.map((p, i) => (
              <IngestPageRow key={i} page={p} />
            ))}
          </ul>
        </details>
      )}

      {plan && (
        <div className="mt-2 rounded-md border border-accent/40 bg-accent-soft/40 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 font-sans text-[12px] font-medium text-accent-pressed">
            <Sparkles size={12} aria-hidden />
            AI consolidation plan
          </div>
          <p className="mb-2 font-sans text-[12px] leading-[16px] text-text-muted">
            Grouping {plan.pages_seen} page{plan.pages_seen === 1 ? "" : "s"} into{" "}
            {plan.files.length} file{plan.files.length === 1 ? "" : "s"}.
          </p>
          <ul className="flex flex-col gap-1">
            {plan.files.map((f) => (
              <PlanRow
                key={f.slug}
                file={f}
                result={files.find((r) => r.slug === f.slug)}
                writing={writingSlug === f.slug}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PlanRow({
  file,
  result,
  writing,
}: {
  file: { title: string; slug: string; description?: string; page_indices: number[] };
  result: IngestUrlFileEvent | undefined;
  writing: boolean;
}) {
  const icon = writing ? (
    <Loader2 size={12} className="animate-spin text-accent" aria-hidden />
  ) : result?.status === "saved" ? (
    <CheckCircle2 size={12} className="text-success" aria-hidden />
  ) : result?.status === "skipped" ? (
    <AlertCircle size={12} className="text-text-muted" aria-hidden />
  ) : result?.status === "failed" ? (
    <XCircle size={12} className="text-danger" aria-hidden />
  ) : (
    <span className="inline-block h-3 w-3 rounded-full border border-border" aria-hidden />
  );
  const detail =
    result?.status === "saved"
      ? `${file.page_indices.length} page${file.page_indices.length === 1 ? "" : "s"}`
      : result?.status === "skipped"
        ? result.reason || "skipped"
        : result?.status === "failed"
          ? result.error || "failed"
          : writing
            ? "writing…"
            : "queued";
  return (
    <li className="flex items-center justify-between gap-2 rounded-sm bg-surface px-2 py-1 font-sans text-[12px]">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-text">{file.title}</span>
        <span className="shrink-0 font-mono text-[11px] text-text-subtle">
          {file.slug}.md
        </span>
      </div>
      <span className="shrink-0 font-mono text-[11px] text-text-muted">{detail}</span>
    </li>
  );
}

function SitemapRow({
  url,
  checked,
  onToggle,
}: {
  url: string;
  checked: boolean;
  onToggle: () => void;
}) {
  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname || "/";
  } catch {
    // keep original
  }
  return (
    <li className="flex items-center gap-2 py-1 font-sans text-[12px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-3.5 w-3.5 shrink-0 accent-accent"
      />
      <button
        type="button"
        onClick={onToggle}
        className="min-w-0 flex-1 truncate text-left text-text hover:text-accent-pressed"
        title={url}
      >
        {path}
      </button>
    </li>
  );
}

function BuildFileRow({ file }: { file: BuildGuidelinesFileEvent }) {
  const icon =
    file.status === "saved" ? (
      <CheckCircle2 size={12} className="text-success" aria-hidden />
    ) : file.status === "skipped" ? (
      <AlertCircle size={12} className="text-text-muted" aria-hidden />
    ) : (
      <XCircle size={12} className="text-danger" aria-hidden />
    );
  const detail =
    file.status === "saved"
      ? `${file.filename}`
      : file.status === "skipped"
        ? file.reason || "skipped"
        : file.error || "failed";
  return (
    <li className="flex items-center justify-between gap-2 rounded-sm bg-surface px-2 py-1 font-sans text-[12px]">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-text">{file.title}</span>
      </div>
      <span className="shrink-0 truncate font-mono text-[11px] text-text-muted">
        {detail}
      </span>
    </li>
  );
}

function shortPath(href: string): string {
  try {
    const u = new URL(href);
    return u.pathname || u.hostname;
  } catch {
    return href;
  }
}

function IngestPageRow({ page }: { page: IngestUrlPageEvent }) {
  const icon =
    page.status === "indexed" || page.status === "fetched" ? (
      <CheckCircle2 size={12} className="text-success" aria-hidden />
    ) : page.status === "skipped" ? (
      <AlertCircle size={12} className="text-text-muted" aria-hidden />
    ) : (
      <XCircle size={12} className="text-danger" aria-hidden />
    );
  const detail =
    page.status === "indexed"
      ? "indexed"
      : page.status === "fetched"
        ? "fetched"
        : page.status === "skipped"
          ? page.reason || "skipped"
          : page.error || "failed";

  return (
    <li className="flex items-center justify-between gap-2 py-1 font-sans text-[12px]">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="text-text-subtle tabular-nums">
          {page.index}/{page.total}
        </span>
        <span className="truncate text-text">{page.title || shortPath(page.url)}</span>
        {page.distilled && (
          <span
            title="AI-distilled before indexing"
            className="inline-flex shrink-0 items-center rounded-sm bg-accent-soft px-1 font-sans text-[10px] uppercase tracking-[0.04em] text-accent-pressed"
          >
            AI
          </span>
        )}
      </div>
      <span className="shrink-0 font-mono text-[11px] text-text-muted">{detail}</span>
    </li>
  );
}

