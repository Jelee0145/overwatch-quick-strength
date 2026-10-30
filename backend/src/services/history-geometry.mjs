/** Shared timeline coordinates. These pure helpers perform no scoring or I/O. */
export function windowRange(total, capacity, start) {
  const size = Math.min(total, Math.max(1, capacity)),
    first = Math.max(0, Math.min(Math.round(start), total - size));
  return { start: first, end: first + size };
}
export function statisticsRange(total, end, selection) {
  return selection === 'all'
    ? { start: 0, end: total }
    : { start: Math.max(0, end - Number(selection)), end };
}
export function axisRange(matches) {
  const values = matches
    .flatMap((m) => [
      ...(m.scores || []),
      ...(m.allRoleScores || []),
      ...(m.estimateRange ? [m.estimateRange.min, m.estimateRange.max] : []),
      m.mean
    ])
    .filter(Number.isFinite);
  const min = values.length
    ? Math.max(500, Math.floor((Math.min(...values) - 100) / 500) * 500)
    : 500;
  let max = values.length
    ? Math.min(5000, Math.ceil((Math.max(...values) + 150) / 500) * 500)
    : 3000;
  if (max <= min) max = Math.min(5000, min + 500);
  return { min, max };
}
