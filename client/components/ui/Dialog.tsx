"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const ref = React.useRef<HTMLDialogElement | null>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    onClose();
  };

  const handleClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === ref.current) {
      onClose();
    }
  };

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClick={handleClick}
      className={cn(
        "rounded-xl border border-border bg-surface-raised p-0",
        "shadow-elev-3 backdrop:bg-black/30",
        "w-[min(480px,calc(100vw-32px))]",
        className,
      )}
    >
      <div className="p-5">
        {title && (
          <h2 className="mb-3 font-serif text-[22px] font-medium leading-[30px] text-text">
            {title}
          </h2>
        )}
        {children}
      </div>
    </dialog>
  );
}
