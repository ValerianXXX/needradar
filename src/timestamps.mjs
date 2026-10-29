// Require an explicit zone and a real calendar date. Date.parse alone silently
// normalizes dates such as February 30 and accepts host-dependent local times.
export function timestamp(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u);
  if (!match) throw new TypeError('VALID_TIMESTAMP_REQUIRED');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59
    || (match[8] !== 'Z' && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4)) > 59))
    || !Number.isFinite(Date.parse(value))) throw new TypeError('VALID_TIMESTAMP_REQUIRED');
  return new Date(value).toISOString();
}
