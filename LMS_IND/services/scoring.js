/*
 * Assessment scoring helpers.
 *
 * The percentage is always computed from the persisted attempt values
 * (correct answers / total questions) on the server. Views receive the number
 * and append the percent sign exactly once.
 */

export function percentOf(correct, total) {
  const correctCount = Number(correct) || 0;
  const totalCount = Number(total) || 0;
  if (totalCount <= 0) return 0;
  const raw = (correctCount / totalCount) * 100;
  return Math.round(raw * 100) / 100;
}

export function formatPercent(correct, total) {
  const value = percentOf(correct, total);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
