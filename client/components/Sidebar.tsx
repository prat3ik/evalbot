"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  match: (pathname: string) => boolean;
}

const items: NavItem[] = [
  {
    href: "/",
    label: "Projects",
    Icon: FolderOpen,
    match: (p) => p === "/" || p.startsWith("/projects"),
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="hidden shrink-0 flex-col border-r border-border bg-surface md:flex"
      style={{ width: 232 }}
    >
      <div className="px-5 pb-5 pt-7">
        <Link href="/" className="inline-flex items-baseline gap-1.5">
          <span className="font-serif text-[22px] font-medium leading-[28px] text-text">
            EvalBot
          </span>
          <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-text-subtle">
            local
          </span>
        </Link>
      </div>

      <nav className="flex flex-col gap-1 px-3">
        {items.map(({ href, label, Icon, match }) => {
          const active = pathname ? match(pathname) : false;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "relative flex h-9 items-center gap-3 rounded-md px-3",
                "font-sans text-[14px] leading-5 transition-colors duration-fast ease-ev",
                active
                  ? "bg-accent-soft text-accent-pressed"
                  : "text-text-muted hover:bg-surface-sunken hover:text-text",
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute bottom-1 left-0 top-1 w-[2px] rounded-full bg-accent"
                />
              )}
              <Icon size={16} strokeWidth={1.5} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border px-5 py-4">
        <p className="font-sans text-[11px] uppercase tracking-[0.06em] text-text-subtle">
          v0.1 · MVP
        </p>
      </div>
    </aside>
  );
}
