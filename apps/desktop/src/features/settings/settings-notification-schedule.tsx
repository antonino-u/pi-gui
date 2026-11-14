import type {
  NotificationPreferences,
  NotificationPreferencesUpdate,
} from "../../../contracts/desktop-state";
import { isPaused } from "../../../contracts/notification-rules";
import { useTranslation, type MessageKey } from "../../i18n";
import { SettingsSelect, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

type PauseChoice = "hour" | "morning" | "indefinite";

const DAY_KEYS: readonly MessageKey[] = [
  "settings.notifications.quietHours.day.sun",
  "settings.notifications.quietHours.day.mon",
  "settings.notifications.quietHours.day.tue",
  "settings.notifications.quietHours.day.wed",
  "settings.notifications.quietHours.day.thu",
  "settings.notifications.quietHours.day.fri",
  "settings.notifications.quietHours.day.sat",
];

/** The next time the clock shows `time` (HH:MM), after `now`. */
function nextOccurrence(time: string, now: Date): Date {
  const [hours = 8, minutes = 0] = time.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function pauseUntil(choice: PauseChoice, preferences: NotificationPreferences): string | null {
  const now = new Date();
  if (choice === "hour") return new Date(now.getTime() + 60 * 60_000).toISOString();
  if (choice === "morning") {
    const morning = preferences.quietHours.enabled ? preferences.quietHours.end : "08:00";
    return nextOccurrence(morning, now).toISOString();
  }
  return null;
}

/**
 * Settings > Notifications: pausing every notification for a while, and quiet hours in which
 * background updates stay silent. Requests for input or approval still come through quiet
 * hours; a pause silences them too.
 */
export function SettingsNotificationSchedule({
  preferences,
  onSetNotificationPreferences,
}: {
  readonly preferences: NotificationPreferences;
  readonly onSetNotificationPreferences: (preferences: NotificationPreferencesUpdate) => void;
}) {
  const { t } = useTranslation();
  const paused = isPaused(preferences, new Date());
  const quietHours = preferences.quietHours;
  // Send only the changed field: the host merges it, so quick edits cannot undo each other.
  const setQuietHours = (change: Partial<NotificationPreferences["quietHours"]>) =>
    onSetNotificationPreferences({ quietHours: change });

  return (
    <SettingsGroup
      title={t("settings.notifications.groupSchedule")}
      description={t("settings.notifications.groupSchedule.description")}
    >
      {paused ? (
        <SettingsRow
          title={t("settings.notifications.pause.pausedTitle")}
          description={
            preferences.pause?.until
              ? t("settings.notifications.pause.pausedUntil", {
                  time: new Date(preferences.pause.until).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })
              : t("settings.notifications.pause.pausedIndefinitely")
          }
        >
          <button
            className="button button--secondary"
            data-testid="notifications-resume"
            type="button"
            onClick={() => onSetNotificationPreferences({ pause: null })}
          >
            {t("settings.notifications.pause.resume")}
          </button>
        </SettingsRow>
      ) : (
        <SettingsRow
          title={t("settings.notifications.pause.title")}
          description={t("settings.notifications.pause.description")}
        >
          <SettingsSelect<PauseChoice>
            label={t("settings.notifications.pause.title")}
            options={[
              { value: "hour", label: t("settings.notifications.pause.hour") },
              { value: "morning", label: t("settings.notifications.pause.morning") },
              { value: "indefinite", label: t("settings.notifications.pause.indefinite") },
            ]}
            value={undefined}
            onChange={(choice) =>
              onSetNotificationPreferences({
                pause: { until: pauseUntil(choice, preferences) },
              })
            }
          />
        </SettingsRow>
      )}
      <SettingsRow
        title={t("settings.notifications.quietHours.title")}
        description={t("settings.notifications.quietHours.description")}
      >
        <SettingsSwitch
          checked={quietHours.enabled}
          label={t("settings.notifications.quietHours.title")}
          onChange={(enabled) => setQuietHours({ enabled })}
        />
      </SettingsRow>
      {quietHours.enabled ? (
        <SettingsRow title={t("settings.notifications.quietHours.when")}>
          <div className="notification-quiet-hours">
            <label className="notification-quiet-hours__time">
              <span>{t("settings.notifications.quietHours.from")}</span>
              <input
                aria-label={t("settings.notifications.quietHours.from")}
                type="time"
                value={quietHours.start}
                onChange={(event) => {
                  const start = event.currentTarget.value;
                  if (start) setQuietHours({ start });
                }}
              />
            </label>
            <label className="notification-quiet-hours__time">
              <span>{t("settings.notifications.quietHours.to")}</span>
              <input
                aria-label={t("settings.notifications.quietHours.to")}
                type="time"
                value={quietHours.end}
                onChange={(event) => {
                  const end = event.currentTarget.value;
                  if (end) setQuietHours({ end });
                }}
              />
            </label>
            <div
              aria-label={t("settings.notifications.quietHours.days")}
              className="notification-quiet-hours__days"
              role="group"
            >
              {DAY_KEYS.map((key, day) => {
                const selected = quietHours.days.includes(day);
                return (
                  <button
                    aria-pressed={selected}
                    className="notification-quiet-hours__day"
                    key={key}
                    type="button"
                    onClick={() =>
                      setQuietHours({
                        days: selected
                          ? quietHours.days.filter((entry) => entry !== day)
                          : [...quietHours.days, day].sort(),
                      })
                    }
                  >
                    {t(key)}
                  </button>
                );
              })}
            </div>
          </div>
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
}
