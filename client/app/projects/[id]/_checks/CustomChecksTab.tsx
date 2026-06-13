// CUSTOM_CHECKS_DISABLED — re-enable in app/projects/[id]/page.tsx tab list.
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ListChecks, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import {
  customChecksApi,
  type CustomCheck,
  type Project,
} from "@/lib/api";

const WEIGHT_HELP =
  "0 = informational only (does not affect combined score). Up to 1.0 lets the check factor into combined.";

export function CustomChecksTab({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const listQ = useQuery({
    queryKey: ["custom-checks", project.id],
    queryFn: () => customChecksApi.list(project.id),
  });

  const invalidate = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["custom-checks", project.id] });
  }, [queryClient, project.id]);

  const [description, setDescription] = React.useState("");
  const [weight, setWeight] = React.useState("0");

  const createMut = useMutation({
    mutationFn: (input: { description: string; weight: number }) =>
      customChecksApi.create(project.id, input),
    onSuccess: () => {
      setDescription("");
      setWeight("0");
      invalidate();
    },
  });

  const checks = listQ.data ?? [];

  const onAdd = () => {
    const desc = description.trim();
    if (!desc) return;
    const w = Number(weight);
    createMut.mutate({
      description: desc,
      weight: Number.isFinite(w) ? w : 0,
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <div className="flex items-center gap-2">
          <ListChecks size={18} className="text-text-muted" aria-hidden />
          <h2 className="font-serif text-[22px] font-medium leading-8 text-text">
            Custom Checks
          </h2>
        </div>
        <p className="mt-1 font-sans text-[14px] leading-[22px] text-text-muted">
          Plain-English rules added to the AI judge prompt. Each check returns a
          score and reason.
        </p>
      </header>

      <Card>
        <div className="flex flex-col gap-3">
          <label className="font-sans text-[12px] font-medium uppercase tracking-[0.04em] text-text-muted">
            New check
          </label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              'Response must include the disclaimer "This is not legal advice".'
            }
            className="min-h-[88px] font-sans text-[14px] leading-[22px]"
          />
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="font-sans text-[12px] font-medium uppercase tracking-[0.04em] text-text-muted">
                Weight
              </label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className="w-24 font-mono text-[14px]"
              />
            </div>
            <p className="max-w-md font-sans text-[12px] leading-[18px] text-text-muted">
              {WEIGHT_HELP}
            </p>
            <div className="ml-auto">
              <Button
                size="sm"
                onClick={onAdd}
                disabled={createMut.isPending || !description.trim()}
              >
                <Plus size={14} aria-hidden />
                {createMut.isPending ? "Adding…" : "Add check"}
              </Button>
            </div>
          </div>
          {createMut.error instanceof Error && (
            <p className="font-sans text-[13px] text-danger">
              {createMut.error.message}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <div className="mb-3">
          <h3 className="font-sans text-[15px] font-semibold leading-[22px] text-text">
            Defined checks
          </h3>
          <p className="font-sans text-[12px] text-text-muted">
            {checks.length === 0
              ? "Plain-English rules appended to the judge prompt."
              : `${checks.length} check${checks.length === 1 ? "" : "s"} active on every evaluation.`}
          </p>
        </div>

        {listQ.isLoading ? (
          <p className="font-sans text-[13px] text-text-muted">Loading…</p>
        ) : checks.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-surface-sunken/40 px-3 py-6 text-center">
            <p className="font-serif text-[16px] leading-[24px] text-text-muted">
              No custom checks yet
            </p>
            <p className="mt-1 font-sans text-[12px] text-text-subtle">
              Add a check above to factor it into every future evaluation.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {checks.map((c) => (
              <CheckRow key={c.id} check={c} onChanged={invalidate} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CheckRow({
  check,
  onChanged,
}: {
  check: CustomCheck;
  onChanged: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [desc, setDesc] = React.useState(check.description);
  const [weight, setWeight] = React.useState(String(check.weight));

  React.useEffect(() => {
    setDesc(check.description);
    setWeight(String(check.weight));
  }, [check.description, check.weight]);

  const updateMut = useMutation({
    mutationFn: () =>
      customChecksApi.update(check.id, {
        description: desc.trim(),
        weight: Number(weight) || 0,
      }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => customChecksApi.delete(check.id),
    onSuccess: onChanged,
  });

  if (editing) {
    return (
      <li className="rounded-md border border-border bg-surface-raised p-3">
        <Textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          className="min-h-[64px] font-sans text-[14px] leading-[22px]"
        />
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="w-24 font-mono text-[14px]"
          />
          <span className="font-sans text-[12px] text-text-muted">weight</span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDesc(check.description);
                setWeight(String(check.weight));
              }}
            >
              <X size={14} aria-hidden /> Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => updateMut.mutate()}
              disabled={updateMut.isPending || !desc.trim()}
            >
              <Check size={14} aria-hidden />
              {updateMut.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-3 rounded-md border border-border bg-surface px-3 py-2">
      <p className="flex-1 font-sans text-[14px] leading-[22px] text-text">
        {check.description}
      </p>
      <Badge variant="neutral" className="mt-0.5 font-mono text-[11px]">
        w {check.weight.toFixed(2)}
      </Badge>
      <div className="flex items-center gap-1 opacity-60 transition-opacity duration-fast ease-ev group-hover:opacity-100">
        <button
          type="button"
          title="Edit"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text"
          onClick={() => setEditing(true)}
        >
          <Pencil size={14} aria-hidden />
        </button>
        <button
          type="button"
          title="Delete"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-danger-soft hover:text-danger"
          onClick={() => {
            if (confirm("Delete this custom check?")) deleteMut.mutate();
          }}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
    </li>
  );
}
