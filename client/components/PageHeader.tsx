import * as React from "react";
import { cn } from "@/lib/cn";

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-5 flex items-start justify-between gap-6", className)}>
      <div>
        <h1 className="font-serif text-[32px] font-medium leading-10 text-text">{title}</h1>
        {subtitle && (
          <p className="mt-1 font-sans text-[15px] leading-[22px] text-text-muted">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
