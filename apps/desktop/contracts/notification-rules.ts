import {
  DEFAULT_QUIET_HOURS,
  type NotificationPreferences,
  type QuietHours,
} from "./desktop-state";

/** What a notification is about: input or approval needed is the one that matters most. */
export type NotificationKind = "completion" | "failure" | "attention";

export type NotificationSilence = "muted" | "paused" | "quiet-hours";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isQuietHoursTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

function minutesOf(value: string): number | undefined {
  const match = TIME_PATTERN.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** Whether `now` (in this computer's time zone) falls inside the quiet hours. */
export function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  if (!quietHours.enabled || quietHours.days.length === 0) return false;
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  if (start === undefined || end === undefined) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const startsToday = quietHours.days.includes(today);
  if (start === end) return startsToday;
  if (start < end) return startsToday && minute >= start && minute < end;
  // Past midnight: the evening part belongs to today, the morning part to the day before.
  return (startsToday && minute >= start) || (quietHours.days.includes(yesterday) && minute < end);
}

export function isPaused(preferences: NotificationPreferences, now: Date): boolean {
  const pause = preferences.pause;
  if (!pause) return false;
  return pause.until === null || Date.parse(pause.until) > now.getTime();
}

/**
 * Why a notification would be silenced, or undefined when it should be shown. A muted thread
 * never notifies. A pause silences everything. Quiet hours let input or approval requests
 * through, so an agent that needs an answer is not left waiting until morning.
 */
export function notificationSilence(
  preferences: NotificationPreferences,
  sessionKey: string,
  kind: NotificationKind,
  now: Date = new Date(),
): NotificationSilence | undefined {
  if (preferences.mutedSessions.includes(sessionKey)) return "muted";
  if (isPaused(preferences, now)) return "paused";
  if (kind !== "attention" && isWithinQuietHours(preferences.quietHours, now)) {
    return "quiet-hours";
  }
  return undefined;
}

const MAX_MUTED_SESSIONS = 1_000;

/** A pause from saved or sent data: null when off, undefined when the value is not a pause. */
export function decodeNotificationPause(
  value: unknown,
): NotificationPreferences["pause"] | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const until = (value as { until?: unknown }).until;
  if (until === null) return { until: null };
  return typeof until === "string" && !Number.isNaN(Date.parse(until)) ? { until } : undefined;
}

export function decodeQuietHours(value: unknown): QuietHours | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<Record<keyof QuietHours, unknown>>;
  if (
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.start !== "string" ||
    !isQuietHoursTime(candidate.start) ||
    typeof candidate.end !== "string" ||
    !isQuietHoursTime(candidate.end) ||
    !Array.isArray(candidate.days) ||
    !candidate.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  ) {
    return undefined;
  }
  return {
    enabled: candidate.enabled,
    start: candidate.start,
    end: candidate.end,
    days: [...new Set(candidate.days as number[])].sort(),
  };
}

/** A change to quiet hours: any of their fields, each valid. */
export function decodeQuietHoursChange(value: unknown): Partial<QuietHours> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const fields = ["enabled", "start", "end", "days"] as const;
  if (Object.keys(candidate).some((key) => !(fields as readonly string[]).includes(key))) {
    return undefined;
  }
  const merged = decodeQuietHours({ ...DEFAULT_QUIET_HOURS, ...candidate });
  if (!merged) return undefined;
  let change: Partial<QuietHours> = {};
  for (const key of fields) {
    if (Object.hasOwn(candidate, key)) change = { ...change, [key]: merged[key] };
  }
  return change;
}

export function decodeMutedSessions(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = value.filter((key): key is string => typeof key === "string" && key.includes(":"));
  return [...new Set(keys)].slice(-MAX_MUTED_SESSIONS);
}

/** Adds or removes one thread from the muted list. */
export function withSessionMuted(
  mutedSessions: readonly string[],
  sessionKey: string,
  muted: boolean,
): readonly string[] {
  const others = mutedSessions.filter((key) => key !== sessionKey);
  return muted ? [...others, sessionKey].slice(-MAX_MUTED_SESSIONS) : others;
}
