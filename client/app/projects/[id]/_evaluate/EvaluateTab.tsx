"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import type { Project } from "@/lib/api";
import { cn } from "@/lib/cn";
import { SingleTurnTab } from "./SingleTurnTab";
import { MultiTurnTab } from "./MultiTurnTab";

type Mode = "single" | "multi";

export function EvaluateTab({ project }: { project: Project }) {
  const searchParams = useSearchParams();
  const initialMode: Mode = searchParams.get("mode") === "multi" ? "multi" : "single";
  const initialConvId = searchParams.get("conv") ?? undefined;

  const [mode, setMode] = React.useState<Mode>(initialMode);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <ModeToggle value={mode} onChange={setMode} />
      </div>

      {mode === "single" ? (
        <SingleTurnTab project={project} />
      ) : (
        <MultiTurnTab project={project} initialConvId={initialConvId} />
      )}
    </div>
  );
}

function ModeToggle({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const options: { label: string; value: Mode }[] = [
    { label: "Single Turn", value: "single" },
    { label: "Multi-Turn Chat", value: "multi" },
  ];
  return (
    <div
      role="tablist"
      className="inline-flex rounded-md border border-border bg-surface-sunken p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 rounded-[6px] px-4 font-sans text-[14px] font-medium transition-colors duration-fast ease-ev",
            value === o.value
              ? "bg-surface-raised text-text shadow-elev-1"
              : "text-text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
