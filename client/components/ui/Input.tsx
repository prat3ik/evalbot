import * as React from "react";
import { cn } from "@/lib/cn";

export type InputSize = "sm" | "md";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  inputSize?: InputSize;
}

const sizeStyles: Record<InputSize, string> = {
  sm: "h-7 px-2.5 text-[13px] leading-[18px]",
  md: "h-9 px-3 text-[15px] leading-[22px]",
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", inputSize = "md", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "block w-full rounded-md",
        "border border-border-strong bg-surface-raised",
        "font-sans text-text",
        "placeholder:text-text-subtle",
        "focus:border-accent focus:shadow-focus-ring focus:outline-none",
        "transition-colors duration-fast ease-ev",
        "disabled:cursor-not-allowed disabled:opacity-50",
        sizeStyles[inputSize],
        className,
      )}
      {...rest}
    />
  );
});
