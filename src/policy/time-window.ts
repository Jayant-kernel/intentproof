function minutesAt(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Unable to resolve time in ${timezone}`);
  }
  return hour * 60 + minute;
}

function parseClock(value: string): number {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    throw new Error(`Invalid policy clock value: ${value}`);
  }
  return hour * 60 + minute;
}

export function isWithinWindow(date: Date, timezone: string, window: string): boolean {
  const [startText, endText] = window.split("-");
  if (!startText || !endText) {
    throw new Error(`Invalid policy time window: ${window}`);
  }

  const current = minutesAt(date, timezone);
  const start = parseClock(startText);
  const end = parseClock(endText);

  if (start === end) {
    return true;
  }
  return start < end ? current >= start && current < end : current >= start || current < end;
}
