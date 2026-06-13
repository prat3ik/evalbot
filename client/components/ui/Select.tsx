import * as React from "react";
import { cn } from "@/lib/cn";

export type SelectSize = "sm" | "md";

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  selectSize?: SelectSize;
}

const sizeStyles: Record<SelectSize, string> = {
  sm: "h-7 pl-2.5 pr-7 text-[13px] leading-[18px]",
  md: "h-9 px-3 pr-8 text-[15px] leading-[22px]",
};

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, selectSize = "md", ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "block w-full rounded-md",
        "border border-border-strong bg-surface-raised",
        "font-sans text-text",
        "focus:border-accent focus:shadow-focus-ring focus:outline-none",
        "transition-colors duration-fast ease-ev",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "appearance-none bg-[right_0.6rem_center] bg-no-repeat",
        sizeStyles[selectSize],
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236B6A63' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
        backgroundSize: "16px 16px",
      }}
      {...rest}
    >
      {children}
    </select>
  );
});
