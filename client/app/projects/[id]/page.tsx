"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Dialog } from "@/components/ui/Dialog";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { api, type Project } from "@/lib/api";
import { cn } from "@/lib/cn";

import { OverviewTab } from "./_overview/OverviewTab";
import { EvaluateTab } from "./_evaluate/EvaluateTab";
import { ActivityTab } from "./_activity/ActivityTab";
import { AnalyticsTab } from "./_analytics/AnalyticsTab";
import { DatasetsTab } from "./_datasets/DatasetsTab";
// CUSTOM_CHECKS_DISABLED — uncomment to re-enable
// import { CustomChecksTab } from "./_checks/CustomChecksTab";
import { ConfigurationTab } from "./_configuration/ConfigurationTab";

type TabKey =
  | "overview"
  | "evaluate"
  | "activity"
  | "datasets"
  // CUSTOM_CHECKS_DISABLED — uncomment to re-enable
  // | "checks"
  | "configuration"
  | "analytics";

// Ordered as a natural workflow: SET UP (overview, configuration) →
// USE (evaluate, datasets) → REVIEW (activity, analytics).
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "configuration", label: "Configuration" },
  { key: "evaluate", label: "Evaluate" },
  { key: "datasets", label: "Datasets" },
  // CUSTOM_CHECKS_DISABLED — uncomment to re-enable
  // { key: "checks", label: "Custom Checks" },
  { key: "activity", label: "Activity" },
  { key: "analytics", label: "Analytics" },
];

export const dynamic = "force-dynamic";

export default function ProjectWorkbenchPage({ params }: { params: { id: string } }) {
  return (
    <React.Suspense fallback={<WorkbenchFallback />}>
      <ProjectWorkbenchInner projectId={params.id} />
    </React.Suspense>
  );
}

function WorkbenchFallback() {
  return (
    <Card>
      <p className="font-sans text-[14px] text-text-muted">Loading project…</p>
    </Card>
  );
}

function ProjectWorkbenchInner({ projectId }: { projectId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const rawTab = searchParams.get("tab");
  const activeTab: TabKey =
    rawTab === "evaluate" ||
    rawTab === "analytics" ||
    rawTab === "activity" ||
    rawTab === "datasets" ||
    // CUSTOM_CHECKS_DISABLED — uncomment to re-enable
    // rawTab === "checks" ||
    rawTab === "configuration"
      ? (rawTab as TabKey)
      : "overview";

  const setTab = React.useCallback(
    (next: TabKey) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set("tab", next);
      router.replace(`/projects/${projectId}?${params.toString()}`);
    },
    [router, searchParams, projectId],
  );

  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.projects.get(projectId),
  });

  const [settingsOpen, setSettingsOpen] = React.useState(false);

  // Allow descendant components (e.g. DatasetsTab "Configure endpoint" chip)
  // to open the project Settings dialog without prop-drilling.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!detail || detail.projectId === projectId) {
        setSettingsOpen(true);
      }
    };
    window.addEventListener("evalbot:open-project-settings", handler);
    return () =>
      window.removeEventListener("evalbot:open-project-settings", handler);
  }, [projectId]);

  // Allow descendant components to navigate to a project tab without having
  // to call useRouter themselves.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string; tab?: string }>).detail;
      if (!detail || !detail.tab) return;
      if (detail.projectId && detail.projectId !== projectId) return;
      setTab(detail.tab as TabKey);
    };
    window.addEventListener("evalbot:open-tab", handler);
    return () => window.removeEventListener("evalbot:open-tab", handler);
  }, [projectId, setTab]);

  const deleteMutation = useMutation({
    mutationFn: () => api.projects.delete(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      router.push("/");
    },
  });

  if (projectQ.isLoading) {
    return <WorkbenchFallback />;
  }
  if (projectQ.isError || !projectQ.data) {
    return (
      <Card>
        <CardTitle>Project not found</CardTitle>
        <p className="mt-2 font-sans text-[14px] text-text-muted">
          We couldn&rsquo;t load this project.{" "}
          <Link href="/" className="text-accent-pressed underline">
            Back to projects
          </Link>
          .
        </p>
      </Card>
    );
  }

  const project: Project = projectQ.data;

  return (
    <>
      <div className="mb-4">
        <Breadcrumbs items={[{ label: "All Projects", href: "/" }, { label: project.name }]} />
      </div>

      <header className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="font-serif text-[26px] font-medium leading-9 text-text">
            {project.name}
          </h1>
          {project.description && (
            <p className="mt-1.5 max-w-3xl font-sans text-[14px] leading-[22px] text-text-muted">
              {project.description}
            </p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true)}>
          <Settings size={14} aria-hidden /> Settings
        </Button>
      </header>

      <div className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => {
          const active = t.key === activeTab;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "-mb-px h-8 border-b-2 px-3 font-sans text-[12px] font-medium uppercase tracking-[0.04em] transition-colors duration-fast ease-ev",
                active
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === "overview" && <OverviewTab project={project} />}
      {activeTab === "evaluate" && <EvaluateTab project={project} />}
      {activeTab === "activity" && <ActivityTab project={project} />}
      {activeTab === "datasets" && <DatasetsTab project={project} />}
      {/* CUSTOM_CHECKS_DISABLED — uncomment to re-enable */}
      {/* {activeTab === "checks" && <CustomChecksTab project={project} />} */}
      {activeTab === "configuration" && <ConfigurationTab project={project} />}
      {activeTab === "analytics" && <AnalyticsTab project={project} />}

      <ProjectSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        project={project}
        onDelete={() => deleteMutation.mutate()}
        deleting={deleteMutation.isPending}
      />
    </>
  );
}

// ---------------- Settings dialog ----------------

function ProjectSettingsDialog({
  open,
  onClose,
  project,
  onDelete,
  deleting,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  onDelete: () => void;
  deleting: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(project.name);
  const [description, setDescription] = React.useState(project.description ?? "");
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription(project.description ?? "");
      setConfirming(false);
    }
  }, [open, project]);

  const updateMut = useMutation({
    mutationFn: (input: { name: string; description: string }) =>
      api.projects.update(project.id, {
        name: input.name,
        description: input.description,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Project details"
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="font-sans text-[13px] font-medium uppercase tracking-[0.04em] text-text">
              Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-sans text-[13px] font-medium uppercase tracking-[0.04em] text-text">
              Description
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[80px]"
            />
          </div>
          {updateMut.error instanceof Error && (
            <p className="font-sans text-[13px] text-danger">
              {updateMut.error.message}
            </p>
          )}
        </div>

        {confirming ? (
          <div className="rounded-md border border-danger bg-danger-soft p-3">
            <p className="mb-3 font-sans text-[14px] text-danger">
              Delete this project and all of its documents, guidelines, and
              evaluations? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={onDelete}
                disabled={deleting}
              >
                <Trash2 size={14} aria-hidden /> Confirm delete
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => setConfirming(true)}
            >
              <Trash2 size={14} aria-hidden /> Delete project
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
              >
                Close
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={updateMut.isPending || !name.trim()}
                onClick={() =>
                  updateMut.mutate({
                    name: name.trim(),
                    description: description.trim(),
                  })
                }
              >
                {updateMut.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
