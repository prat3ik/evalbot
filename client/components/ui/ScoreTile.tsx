"use client";

import * as React from "react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";
import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { scoreBandClasses } from "@/lib/scoreColor";

export type ScoreTileSize = "sm" | "md" | "lg";

export interface ScoreTileProps {
  label: string;
  value: number;
  /** When true, draws the 4px band-colored bottom rail for emphasis. */
  primary?: boolean;
  size?: ScoreTileSize;
  className?: string;
  /** Animate the number from 0 → value on mount. Defaults true for `lg`, false otherwise. */
  animate?: boolean;
  /** Show a small ✓/✗ badge in the top-right corner. Omitted when undefined. */
  pass?: boolean;
}

const railClasses: Record<"success" | "warn" | "danger", string> = {
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
};

const sizeStyles: Record<ScoreTileSize, { container: string; number: string }> = {
  sm: {
    container: "p-3",
    number: "text-[36px] leading-[40px]",
  },
  md: {
    container: "p-4",
    number: "text-[48px] leading-[52px]",
  },
  lg: {
    container: "p-6",
    number: "text-[56px] leading-[60px]",
  },
};

// Demo easing curve (matches --ev-ease in design.md).
const COUNT_EASE: [number, number, number, number] = [0.2, 0, 0, 1];
const COUNT_DURATION_S = 0.6;

function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(0);
  const display = useTransform(mv, (n) => n.toFixed(1));

  React.useEffect(() => {
    const controls = animate(mv, value, {
      duration: COUNT_DURATION_S,
      ease: COUNT_EASE,
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <motion.span className={className}>{display}</motion.span>;
}

export function ScoreTile({
  label,
  value,
  primary = false,
  size = "md",
  className,
  animate: animateProp,
  pass,
}: ScoreTileProps) {
  const { fgClass, band } = scoreBandClasses(value);
  const finite = Number.isFinite(value);
  const display = finite ? value.toFixed(1) : "—";
  const s = sizeStyles[size];
  const shouldAnimate = (animateProp ?? size === "lg") && finite;

  const railColor = primary
    ? pass === true
      ? "bg-success"
      : pass === false
        ? "bg-danger"
        : railClasses[band]
    : null;

  const TileWrapper: any = primary ? motion.div : "div";
  const wrapperProps = primary
    ? {
        initial: { boxShadow: "0 0 0 0 rgba(0,0,0,0)" },
        animate: {
          boxShadow:
            pass === true
              ? "0 0 0 3px rgba(90, 143, 92, 0.25)"
              : pass === false
                ? "0 0 0 3px rgba(181, 82, 63, 0.25)"
                : "0 0 0 0 rgba(0,0,0,0)",
        },
        transition: { duration: 0.2, ease: COUNT_EASE },
      }
    : {};

  return (
    <TileWrapper
      {...wrapperProps}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-surface-raised",
        s.container,
        className,
      )}
    >
      <div className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
        {label}
      </div>
      <div className={cn("mt-2 font-serif font-medium tabular-nums", s.number, fgClass)}>
        {shouldAnimate ? <AnimatedNumber value={value} /> : display}
      </div>

      {pass !== undefined && finite && (
        <span
          className={cn(
            "absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center",
            pass ? "text-success" : "text-danger",
          )}
          aria-label={pass ? "Pass" : "Fail"}
          title={pass ? "Pass" : "Fail"}
        >
          {pass ? <CheckCircle size={14} strokeWidth={2} /> : <XCircle size={14} strokeWidth={2} />}
        </span>
      )}

      {primary && railColor && (
        <div className={cn("absolute bottom-0 left-0 right-0 h-1", railColor)} />
      )}
    </TileWrapper>
  );
}
