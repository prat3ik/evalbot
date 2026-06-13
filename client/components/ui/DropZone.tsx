"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/cn";

export interface DropZoneProps {
  /** Comma-separated `accept` attr value, e.g. ".pdf,.md,.txt,.docx" */
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

export function DropZone({
  accept,
  multiple = true,
  onFiles,
  label = "Drop files here or click to browse",
  hint,
  disabled = false,
  className,
}: DropZoneProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [hover, setHover] = React.useState(false);

  const acceptExts = React.useMemo(
    () =>
      accept
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    [accept],
  );

  const filterAccepted = (files: File[]): File[] => {
    if (acceptExts.length === 0) return files;
    return files.filter((f) => {
      const lower = f.name.toLowerCase();
      return acceptExts.some((ext) => lower.endsWith(ext));
    });
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setHover(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    const accepted = filterAccepted(files);
    if (accepted.length > 0) onFiles(accepted);
  };

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFiles(files);
    // reset so the same file can be re-selected
    e.target.value = "";
  };

  const handleClick = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={handleDrop}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex flex-col items-center justify-center gap-2",
        "cursor-pointer rounded-lg border border-dashed px-6 py-8",
        "transition-colors duration-fast ease-ev",
        hover
          ? "bg-accent-soft/60 border-accent"
          : "bg-surface-sunken/40 border-border-strong hover:bg-surface-sunken",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <Upload size={20} className="text-text-muted" aria-hidden />
      <p className="font-sans text-[14px] leading-5 text-text">{label}</p>
      {hint && <p className="font-sans text-[13px] leading-[18px] text-text-muted">{hint}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleSelect}
        className="hidden"
      />
    </div>
  );
}
