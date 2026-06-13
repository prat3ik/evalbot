"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderOpen, LayoutGrid, List, Plus, ShieldCheck } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Dialog } from "@/components/ui/Dialog";
import { api, type Document, type GuidelineFile, type Project } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/cn";

type ViewMode = "grid" | "list";

export default function ProjectsLandingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [view, setView] = React.useState<ViewMode>("grid");

  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list(),
  });

  const projects: Project[] = projectsQ.data ?? [];

  const createMutation = useMutation({
    mutationFn: (input: { name: string; description: string }) => api.projects.create(input),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setCreateOpen(false);
      router.push(`/projects/${project.id}?tab=overview`);
    },
  });

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Pick a project to open its workbench, or create a new one."
        actions={
          <div className="flex items-center gap-2">
            {projects.length > 0 && <ViewToggle value={view} onChange={setView} />}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} aria-hidden /> New Project
            </Button>
          </div>
        }
      />

      {projectsQ.isLoading ? (
        <Card>
          <p className="font-sans text-[14px] text-text-muted">Loading…</p>
        </Card>
      ) : projects.length === 0 ? (
        <Card className="flex flex-col items-center py-16 text-center">
          <h2 className="font-serif text-[22px] font-medium leading-[30px] text-text">
            Create your first bot project
          </h2>
          <p className="mb-6 mt-2 max-w-md font-serif text-[16px] leading-[26px] text-text-muted">
            A project is a chatbot under test plus its reference documents and company guidelines.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={18} aria-hidden /> New Project
          </Button>
        </Card>
      ) : (
        view === "grid" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
            <NewProjectTile onClick={() => setCreateOpen(true)} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {projects.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="bg-surface/40 flex items-center justify-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 font-sans text-[13px] font-medium text-text-muted transition-colors duration-fast ease-ev hover:border-accent hover:bg-accent-soft hover:text-text"
            >
              <Plus size={14} aria-hidden /> New Project
            </button>
          </div>
        )
      )}

      <CreateProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={(input) => createMutation.mutate(input)}
        submitting={createMutation.isPending}
        error={createMutation.error instanceof Error ? createMutation.error.message : null}
      />
    </>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const docsQ = useQuery({
    queryKey: ["documents", project.id],
    queryFn: () => api.documents.list(project.id),
  });
  const guidelinesQ = useQuery({
    queryKey: ["guidelines", project.id],
    queryFn: () => api.guidelines.list(project.id),
  });

  const docs: Document[] = docsQ.data ?? [];
  const guidelines: GuidelineFile[] = guidelinesQ.data ?? [];

  return (
    <Link href={`/projects/${project.id}?tab=overview`} className="group block">
      <Card className="h-full p-3 transition-colors duration-fast ease-ev hover:border-border-strong">
        <div className="flex items-start gap-2.5">
          <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-pressed">
            <FolderOpen size={14} strokeWidth={1.5} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-serif text-[15px] font-medium leading-5 text-text">
              {project.name}
            </h3>
            <p className="mt-0.5 line-clamp-1 font-sans text-[12px] leading-[16px] text-text-muted">
              {project.description || "No description"}
            </p>
          </div>
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3 font-sans text-[12px] text-text-muted">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <FileText size={12} aria-hidden /> {docs.length}
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck size={12} aria-hidden /> {guidelines.length}
            </span>
          </div>
          <span className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-subtle">
            {relativeTime(project.created_at)}
          </span>
        </div>
      </Card>
    </Link>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  const options: { value: ViewMode; icon: React.ReactNode; label: string }[] = [
    { value: "grid", icon: <LayoutGrid size={14} aria-hidden />, label: "Grid view" },
    { value: "list", icon: <List size={14} aria-hidden />, label: "List view" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-sunken p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.label}
          aria-label={opt.label}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-[6px]",
            "transition-colors duration-fast ease-ev",
            value === opt.value
              ? "bg-surface-raised text-text shadow-elev-1"
              : "text-text-muted hover:text-text",
          )}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const docsQ = useQuery({
    queryKey: ["documents", project.id],
    queryFn: () => api.documents.list(project.id),
  });
  const guidelinesQ = useQuery({
    queryKey: ["guidelines", project.id],
    queryFn: () => api.guidelines.list(project.id),
  });

  const docs: Document[] = docsQ.data ?? [];
  const guidelines: GuidelineFile[] = guidelinesQ.data ?? [];

  return (
    <Link
      href={`/projects/${project.id}?tab=overview`}
      className="group flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors duration-fast ease-ev hover:border-border-strong hover:bg-surface-raised"
    >
      <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-pressed">
        <FolderOpen size={14} strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate font-serif text-[15px] font-medium leading-5 text-text">
            {project.name}
          </h3>
          <p className="truncate font-sans text-[12px] text-text-muted">
            {project.description || "No description"}
          </p>
        </div>
      </div>
      <div className="hidden items-center gap-4 font-sans text-[12px] text-text-muted sm:flex">
        <span className="inline-flex items-center gap-1">
          <FileText size={12} aria-hidden /> {docs.length}
        </span>
        <span className="inline-flex items-center gap-1">
          <ShieldCheck size={12} aria-hidden /> {guidelines.length}
        </span>
      </div>
      <span className="hidden font-sans text-[11px] uppercase tracking-[0.04em] text-text-subtle md:inline">
        {relativeTime(project.created_at)}
      </span>
    </Link>
  );
}

function NewProjectTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-surface/40 flex min-h-[96px] flex-col items-center justify-center rounded-lg border border-dashed border-border-strong transition-colors duration-fast ease-ev hover:border-accent hover:bg-accent-soft"
    >
      <Plus size={18} className="mb-1 text-text-muted" aria-hidden />
      <span className="font-sans text-[13px] font-medium text-text">New Project</span>
    </button>
  );
}

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description: string }) => void;
  submitting: boolean;
  error: string | null;
}

function CreateProjectDialog({
  open,
  onClose,
  onSubmit,
  submitting,
  error,
}: CreateProjectDialogProps) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), description: description.trim() });
  };

  return (
    <Dialog open={open} onClose={onClose} title="New bot project">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="project-name"
            className="font-sans text-[13px] font-medium uppercase tracking-[0.04em] text-text"
          >
            Name
          </label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Support Bot"
            autoFocus
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="project-description"
            className="font-sans text-[13px] font-medium uppercase tracking-[0.04em] text-text"
          >
            Description
          </label>
          <Textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this bot does and what you're testing."
            className="min-h-[96px]"
          />
        </div>
        {error && <p className="font-sans text-[13px] leading-[18px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
