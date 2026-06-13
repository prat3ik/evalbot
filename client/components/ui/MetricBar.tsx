import * as React from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { scoreBandClasses } from "@/lib/scoreColor";

export interface MetricBarProps {
  label: string;
  value: number;
  className?: string;
  /** Optional pass/fail pill rendered to the right of the percentage. */
  pass?: boolean;
}

const fillClasses: Record<"success" | "warn" | "danger", string> = {
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
};

export function MetricBar({ label, value, className, pass }: MetricBarProps) {
  const { band } = scoreBandClasses(value);
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div className={cn("w-full", className)}>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-sans text-[13px] leading-[18px] text-text">{label}</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[14px] font-medium tabular-nums leading-5 text-text">
            {clamped.toFixed(1)}%
          </span>
          {pass !== undefined && (
            <span
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full",
                pass ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
              )}
              aria-label={pass ? "Pass" : "Fail"}
              title={pass ? "Pass" : "Fail"}
            >
              {pass ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn("h-full rounded-full", fillClasses[band])}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
