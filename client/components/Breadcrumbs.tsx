"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "flex flex-wrap items-center gap-1.5 font-sans text-[13px] leading-[18px]",
        className,
      )}
    >
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <React.Fragment key={`${i}-${item.label}`}>
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden />
            )}
            {isLast || !item.href ? (
              <span
                className={cn(
                  "max-w-[40ch] truncate",
                  isLast ? "font-medium text-text" : "text-text-muted",
                )}
                aria-current={isLast ? "page" : undefined}
              >
                {item.label}
              </span>
            ) : (
              <Link
                href={item.href}
                className="max-w-[40ch] truncate text-text-muted transition-colors duration-fast ease-ev hover:text-text"
              >
                {item.label}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
