// The scheduled loops, and how long each may go quiet before that is news.
// Cadence and tolerance belong together: held apart, one hand-picked threshold
// grew to twice the period it watched, and a missed run stopped being visible.

const HOUR = 3600;

export const JOBS = [
  { name: 'harvest', args: ['bin/kb.js', 'harvest'], periodHours: 24,
    schedule: { calendar: { Hour: 3, Minute: 30 } }, onCalendar: '*-*-* 03:30:00' },
  { name: 'reindex', args: ['bin/kb.js', 'vault', 'reindex'], periodHours: 300 / HOUR,
    schedule: { interval: 300 } },
  { name: 'synthesis', args: ['bin/weekly-synthesis.js'], periodHours: 24 * 7,
    schedule: { calendar: { Weekday: 0, Hour: 4, Minute: 0 } }, onCalendar: 'Sun *-*-* 04:00:00' },
];

// Slack on top of one period, to absorb a scheduler that fires late — launchd
// calendar jobs have been observed running an hour behind. Floored at 1h so a
// 5-minute loop is not reported for one skipped tick, and capped at 6h so a
// weekly loop does not inherit a proportionally enormous blind window.
const MIN_SLACK_HOURS = 1;
const MAX_SLACK_HOURS = 6;

export const staleAfterHours = (periodHours) =>
  periodHours + Math.min(MAX_SLACK_HOURS, Math.max(MIN_SLACK_HOURS, periodHours / 4));

export const STALE_AFTER = Object.fromEntries(
  JOBS.map(job => [job.name, staleAfterHours(job.periodHours)])
);
