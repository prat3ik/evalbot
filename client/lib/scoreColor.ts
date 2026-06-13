export type ScoreBand = "success" | "warn" | "danger";

/**
 * Tailwind class helpers keyed by score band, per design.md:
 *   >= 80 → success (green)
 *   >= 60 → warn (amber)
 *   <  60 → danger (red)
 */
export function scoreBandClasses(score: number): {
  fgClass: string;
  bgClass: string;
  band: ScoreBand;
} {
  if (score >= 80) {
    return { fgClass: "text-success", bgClass: "bg-success-soft", band: "success" };
  }
  if (score >= 60) {
    return { fgClass: "text-warn", bgClass: "bg-warn-soft", band: "warn" };
  }
  return { fgClass: "text-danger", bgClass: "bg-danger-soft", band: "danger" };
}
