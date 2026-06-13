"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Settings, Star, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import {
  ChatbotEndpointDialog,
  EndpointKindBadge,
} from "@/components/ChatbotEndpointDialog";
import {
  api,
  chatbotEndpointsApi,
  type ChatbotEndpoint,
  type Project,
} from "@/lib/api";

export function ConfigurationTab({ project }: { project: Project }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="font-sans text-[13px] leading-[20px] text-text-muted">
        Chatbot endpoints let dataset runs and evaluations fetch responses
        directly from your bot. Configure one or more here.
      </p>

      <Card className="p-5">
        <div className="mb-3 border-b border-border pb-3">
          <CardTitle>Chatbot Endpoints</CardTitle>
          <p className="mt-0.5 font-sans text-[12px] text-text-muted">
            Manage the HTTP endpoints EvalBot uses to talk to your chatbot.
          </p>
        </div>
        <ChatbotEndpointsPanel projectId={project.id} />
      </Card>

      <Card className="p-5">
        <div className="mb-3 border-b border-border pb-3">
          <CardTitle>Allowed PII / strings</CardTitle>
          <p className="mt-0.5 font-sans text-[12px] text-text-muted">
            Strings that should NOT be flagged as PII leaks. Use literal
            strings or regex (one per line). Example:{" "}
            <code className="font-mono">support@eval.com</code>
          </p>
        </div>
        <AllowedPiiPanel project={project} />
      </Card>
    </div>
  );
}

function AllowedPiiPanel({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [text, setText] = React.useState<string>(
    project.allowed_pii_patterns ?? "",
  );
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    setText(project.allowed_pii_patterns ?? "");
  }, [project.allowed_pii_patterns, project.id]);

  const mut = useMutation({
    mutationFn: (value: string) =>
      api.projects.update(project.id, { allowed_pii_patterns: value }),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      window.setTimeout(() => setSaved(false), 1800);
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        spellCheck={false}
        placeholder={"support@alphabin.com\n^.*@alphabin\\.com$"}
        className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-[12px] leading-[18px] text-text outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => mut.mutate(text)}
          disabled={mut.isPending || text === (project.allowed_pii_patterns ?? "")}
        >
          {mut.isPending ? "Saving…" : "Save"}
        </Button>
        {saved && (
          <span className="font-sans text-[12px] text-text-muted">Saved.</span>
        )}
        {mut.isError && (
          <span className="font-sans text-[12px] text-danger">
            {(mut.error as Error).message}
          </span>
        )}
      </div>
    </div>
  );
}

function ChatbotEndpointsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const listQ = useQuery({
    queryKey: ["chatbot-endpoints", projectId],
    queryFn: () => chatbotEndpointsApi.list(projectId),
  });
  const [editing, setEditing] = React.useState<ChatbotEndpoint | "new" | null>(
    null,
  );

  const invalidate = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["chatbot-endpoints", projectId] });
  }, [queryClient, projectId]);

  const deleteMut = useMutation({
    mutationFn: (id: string) => chatbotEndpointsApi.delete(id),
    onSuccess: invalidate,
  });
  const setDefaultMut = useMutation({
    mutationFn: (id: string) =>
      chatbotEndpointsApi.update(id, { is_default: true }),
    onSuccess: invalidate,
  });

  const endpoints = listQ.data ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-sans text-[12px] text-text-muted">
          Configure N endpoints; pick one per dataset run or single evaluation.
        </p>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden /> Add endpoint
        </Button>
      </div>

      {listQ.isLoading ? (
        <p className="font-sans text-[13px] text-text-muted">Loading…</p>
      ) : endpoints.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-surface-sunken/30 px-3 py-4 font-sans text-[13px] text-text-muted">
          No endpoints configured — dataset rows must include a manual
          chatbot_response.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {endpoints.map((ep) => (
            <li
              key={ep.id}
              className="group flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-sans text-[14px] font-medium text-text">
                    {ep.name}
                  </span>
                  {ep.is_default && (
                    <Badge variant="accent" className="text-[10px]">
                      Default
                    </Badge>
                  )}
                  <EndpointKindBadge url={ep.url} />
                </div>
                <div
                  className="truncate font-mono text-[12px] text-text-muted"
                  title={ep.url}
                >
                  {ep.method} {ep.url}
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-60 transition-opacity duration-fast ease-ev group-hover:opacity-100">
                {!ep.is_default && (
                  <button
                    type="button"
                    title="Set as default"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text"
                    onClick={() => setDefaultMut.mutate(ep.id)}
                  >
                    <Star size={14} aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  title="Edit"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text"
                  onClick={() => setEditing(ep)}
                >
                  <Settings size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  title="Delete"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-danger-soft hover:text-danger"
                  onClick={() => {
                    if (confirm(`Delete endpoint "${ep.name}"?`)) {
                      deleteMut.mutate(ep.id);
                    }
                  }}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ChatbotEndpointDialog
          projectId={projectId}
          endpoint={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
