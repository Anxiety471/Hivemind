// Offset probes for the Go port's tz parity corpus.
//
// The gateway must read the same tz database production Node's ICU reads, so
// the corpus and its live check both ask Intl — never tzdata files — for a
// zone's offset at an instant. Run everything here with production node
// (~/.local/opt/node24/bin/node).
//
// The offset of a zone at an instant is the wall-clock reading Intl reports
// minus the instant. `formatToParts` gives whole seconds only, so callers pass
// second-aligned instants.
const formatters = new Map();

function formatter(zone) {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, format);
  }
  return format;
}

/** Whether Intl accepts `zone` as a time zone name. */
export function supports(zone) {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at `instant` (ms), in seconds. */
export function offsetAt(zone, instant) {
  const parts = {};
  for (const { type, value } of formatter(zone).formatToParts(instant)) parts[type] = value;
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (local - instant) / 1000;
}

const STEP_MS = 6 * 3600 * 1000;

/**
 * The instants in [from, to] at which the zone's offset changes, to the
 * second. Offsets are piecewise constant, so a 6-hour scan finds every change
 * and a bisection finds the first second of the new offset.
 */
export function transitionsBetween(zone, from, to) {
  const transitions = [];
  let previous = offsetAt(zone, from);
  for (let at = from + STEP_MS; at <= to; at += STEP_MS) {
    const current = offsetAt(zone, at);
    if (current === previous) continue;
    let low = at - STEP_MS;
    let high = at;
    while (high - low > 1000) {
      const middle = low + Math.floor((high - low) / 2000) * 1000;
      if (middle === low) break;
      if (offsetAt(zone, middle) === previous) low = middle;
      else high = middle;
    }
    transitions.push(high);
    previous = current;
  }
  return transitions;
}
