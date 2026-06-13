import * as React from "react";
import { cn } from "@/lib/cn";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** When true, renders with monospace font (for response / schema editors). */
  mono?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono = false, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "block min-h-[160px] w-full rounded-md px-3 py-2",
        "border border-border-strong bg-surface-raised",
        "text-[14px] leading-[22px] text-text",
        "placeholder:text-text-subtle",
        "focus:border-accent focus:shadow-focus-ring focus:outline-none",
        "transition-colors duration-fast ease-ev",
        "disabled:cursor-not-allowed disabled:opacity-50",
        mono ? "font-mono" : "font-sans",
        className,
      )}
      {...rest}
    />
  );
});
