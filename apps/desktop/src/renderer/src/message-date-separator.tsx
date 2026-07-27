import { useEffect, useState } from "react";

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface MessageDateSeparatorProps {
  readonly value: string;
}

const DAY_IN_MILLISECONDS = 86_400_000;

function millisecondsUntilNextLocalDay(now: Date): number {
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  return Math.max(nextDay.getTime() - now.getTime(), 1);
}

function useCurrentDate(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const current = new Date();
    const timeout = window.setTimeout(() => {
      setNow(new Date());
    }, millisecondsUntilNextLocalDay(current));
    return () => {
      window.clearTimeout(timeout);
    };
  }, [now]);

  return now;
}

function calendarDate(value: string | Date, timeZone?: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (![year, month, day].every(Number.isInteger)) throw new Error("Invalid message timestamp");
  return { year, month, day };
}

function calendarOrdinal(value: CalendarDate): number {
  return Date.UTC(value.year, value.month - 1, value.day) / DAY_IN_MILLISECONDS;
}

export function messageDayKey(value: string, timeZone?: string): string {
  const date = calendarDate(value, timeZone);
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function shouldShowDateSeparator(
  current: string,
  previous: string | null,
  timeZone?: string,
): boolean {
  return (
    previous === null || messageDayKey(current, timeZone) !== messageDayKey(previous, timeZone)
  );
}

export function messageDateLabel(
  value: string,
  now = new Date(),
  locale?: string,
  timeZone?: string,
): string {
  const messageDate = calendarDate(value, timeZone);
  const currentDate = calendarDate(now, timeZone);
  const difference = calendarOrdinal(currentDate) - calendarOrdinal(messageDate);
  if (difference === 0) return "Today";
  if (difference === 1) return "Yesterday";

  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(messageDate.year === currentDate.year ? {} : { year: "numeric" as const }),
  }).format(new Date(value));
}

export function MessageDateSeparator({ value }: MessageDateSeparatorProps) {
  const label = messageDateLabel(value, useCurrentDate());
  return (
    <div className="message-date-separator" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}
