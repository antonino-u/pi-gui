import { expect, test } from "@playwright/test";
import { DEFAULT_QUIET_HOURS, type NotificationPreferences } from "../../contracts/desktop-state";
import {
  decodeNotificationPause,
  decodeQuietHours,
  isWithinQuietHours,
  notificationSilence,
  withSessionMuted,
} from "../../contracts/notification-rules";
import { expectNotificationPreferences } from "../../electron/ipc/request-validation";
import { decodePersistedUiState } from "../../electron/persistence/app-store-persistence";

const base: NotificationPreferences = {
  backgroundCompletion: true,
  backgroundFailure: true,
  attentionNeeded: true,
  mutedSessions: [],
  pause: null,
  quietHours: DEFAULT_QUIET_HOURS,
};

// Local times; 2030-01-07 is a Monday.
const at = (day: number, hours: number, minutes = 0) => new Date(2030, 0, day, hours, minutes);
const nightly = { enabled: true, start: "22:00", end: "08:00", days: [1, 2, 3, 4, 5] };

test("quiet hours past midnight belong to the day they start on", () => {
  expect(isWithinQuietHours(nightly, at(7, 21, 59))).toBe(false);
  expect(isWithinQuietHours(nightly, at(7, 22, 0))).toBe(true);
  // Tuesday 03:00 is inside Monday night's quiet hours.
  expect(isWithinQuietHours(nightly, at(8, 3, 0))).toBe(true);
  expect(isWithinQuietHours(nightly, at(8, 8, 0))).toBe(false);
  // Saturday 03:00 is Friday night's; Sunday 03:00 is Saturday night's, which is not listed.
  expect(isWithinQuietHours(nightly, at(12, 3, 0))).toBe(true);
  expect(isWithinQuietHours(nightly, at(13, 3, 0))).toBe(false);
  expect(isWithinQuietHours(nightly, at(12, 23, 0))).toBe(false);
});

test("quiet hours within a day, all day, and off", () => {
  const lunch = { enabled: true, start: "12:00", end: "13:30", days: [1] };
  expect(isWithinQuietHours(lunch, at(7, 12, 45))).toBe(true);
  expect(isWithinQuietHours(lunch, at(7, 13, 30))).toBe(false);
  expect(isWithinQuietHours(lunch, at(8, 12, 45))).toBe(false);
  const allDay = { enabled: true, start: "09:00", end: "09:00", days: [1] };
  expect(isWithinQuietHours(allDay, at(7, 3, 0))).toBe(true);
  expect(isWithinQuietHours({ ...nightly, enabled: false }, at(7, 23, 0))).toBe(false);
});

test("a muted thread never notifies, a pause silences all, quiet hours let requests through", () => {
  const now = at(7, 23, 0);
  const muted = { ...base, mutedSessions: ["w:s1"] };
  expect(notificationSilence(muted, "w:s1", "attention", now)).toBe("muted");
  expect(notificationSilence(muted, "w:s2", "completion", now)).toBeUndefined();

  const paused = { ...base, pause: { until: null } };
  expect(notificationSilence(paused, "w:s2", "attention", now)).toBe("paused");
  const pausedUntil = { ...base, pause: { until: at(7, 23, 30).toISOString() } };
  expect(notificationSilence(pausedUntil, "w:s2", "failure", now)).toBe("paused");
  expect(notificationSilence(pausedUntil, "w:s2", "failure", at(7, 23, 31))).toBeUndefined();

  const quiet = { ...base, quietHours: nightly };
  expect(notificationSilence(quiet, "w:s2", "completion", now)).toBe("quiet-hours");
  expect(notificationSilence(quiet, "w:s2", "failure", now)).toBe("quiet-hours");
  expect(notificationSilence(quiet, "w:s2", "attention", now)).toBeUndefined();
});

test("mute lists, pauses and quiet hours are decoded strictly", () => {
  expect(withSessionMuted(["w:a"], "w:b", true)).toEqual(["w:a", "w:b"]);
  expect(withSessionMuted(["w:a", "w:b"], "w:a", false)).toEqual(["w:b"]);
  expect(withSessionMuted(["w:a"], "w:a", true)).toEqual(["w:a"]);
  expect(decodeNotificationPause(null)).toBeNull();
  expect(decodeNotificationPause({ until: null })).toEqual({ until: null });
  expect(decodeNotificationPause({ until: "later" })).toBeUndefined();
  expect(decodeQuietHours({ ...nightly, days: [5, 1, 1] })).toEqual({ ...nightly, days: [1, 5] });
  expect(decodeQuietHours({ ...nightly, start: "25:00" })).toBeUndefined();
  expect(decodeQuietHours({ ...nightly, days: [7] })).toBeUndefined();

  expect(expectNotificationPreferences({ pause: { until: null } })).toEqual({
    pause: { until: null },
  });
  // Quiet hours change one field at a time.
  expect(expectNotificationPreferences({ quietHours: { end: "07:30" } })).toEqual({
    quietHours: { end: "07:30" },
  });
  expect(() => expectNotificationPreferences({ quietHours: { end: "7:30pm" } })).toThrow(
    "preferences.quietHours",
  );
  expect(() => expectNotificationPreferences({ quietHours: { volume: 3 } })).toThrow(
    "preferences.quietHours",
  );
  // Muting has its own request; the preferences request ignores a muted list.
  expect(expectNotificationPreferences({ mutedSessions: ["w:s"] })).toEqual({});
});

test("saved preferences from before mute, pause and quiet hours still load", () => {
  const decoded = decodePersistedUiState({
    notificationPreferences: { backgroundCompletion: false },
  });
  expect(decoded.notificationPreferences).toEqual({ backgroundCompletion: false });
});
