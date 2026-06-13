/**
 * Hardcoded demo thresholds for pass/fail badges on score tiles and
 * detailed metric rows. Values are on the 0–100 scale that matches the
 * server-side combined/dimension scores.
 *
 * Single source of truth for the badges in EvaluationResultPanel.
 */

export const DIMENSION_THRESHOLDS = {
  similarity: 60,
  accuracy: 70,
  completeness: 65,
  relevance: 70,
  readability: 50,
  combined: 75,
} as const;

export type DimensionKey = keyof typeof DIMENSION_THRESHOLDS;

export function passesThreshold(key: DimensionKey, value: number | null | undefined): boolean {
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  return value >= DIMENSION_THRESHOLDS[key];
}
