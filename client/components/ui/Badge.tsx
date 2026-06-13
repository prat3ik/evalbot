import * as React from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant = "neutral" | "accent" | "success" | "warn" | "danger" | "info";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantStyles: Record<BadgeVariant, string> = {
  neutral: "bg-surface-sunken text-text-muted",
  accent: "bg-accent-soft text-accent-pressed",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export function Badge({ className, variant = "neutral", ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center rounded-sm px-2 font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em]",
        variantStyles[variant],
        className,
      )}
      {...rest}
    />
  );
}
