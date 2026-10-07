export function advanceGameDays(state, count, stepDay) {
  const days = Math.max(0, Math.floor(Number(count) || 0));
  const results = [];
  for (let index = 0; index < days; index += 1) {
    results.push(stepDay(state));
  }
  return { daysAdvanced: results.length, results };
}
