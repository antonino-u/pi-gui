import type { DesktopNotificationPermissionStatus } from "../../../contracts/ipc";
import type { NotificationPreferences } from "../../../contracts/desktop-state";
import { useTranslation, type Translate } from "../../i18n";
import { hasHostScreen } from "../../lib/surface";
import { SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsNotificationsSectionProps {
  readonly notificationPreferences: NotificationPreferences;
  readonly notificationPermissionStatus: DesktopNotificationPermissionStatus;
  readonly notificationPermissionPending: boolean;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
  readonly onRequestNotificationPermission: () => void;
  readonly onOpenSystemNotificationSettings: () => void;
}

export function SettingsNotificationsSection({
  notificationPreferences,
  notificationPermissionStatus,
  notificationPermissionPending,
  onSetNotificationPreferences,
  onRequestNotificationPermission,
  onOpenSystemNotificationSettings,
}: SettingsNotificationsSectionProps) {
  const { t } = useTranslation();
  // A paired browser asks its own browser, not macOS, and cannot open System Settings.
  const browser = !hasHostScreen();
  const statusLabel = labelForPermissionStatus(t, notificationPermissionStatus);
  const statusDescription = descriptionForPermissionStatus(
    t,
    notificationPermissionStatus,
    browser,
  );
  const showAskMacOs = notificationPermissionStatus === "default";
  const showOpenSystemSettings = notificationPermissionStatus === "denied" && !browser;
  const showRecoveryActions = showAskMacOs || showOpenSystemSettings;

  return (
    <>
      <SettingsGroup
        title={t("settings.notifications.groupSystem")}
        description={
          browser
            ? t("settings.notifications.browser.groupSystem.description")
            : t("settings.notifications.groupSystem.description")
        }
      >
        <SettingsRow
          title={
            browser
              ? t("settings.notifications.browser.access.title")
              : t("settings.notifications.access.title")
          }
          description={statusDescription}
        >
          <span className="settings-row__value">{statusLabel}</span>
        </SettingsRow>
        {showRecoveryActions ? (
          <SettingsRow
            title={t("settings.notifications.turnOn.title")}
            description={
              showAskMacOs
                ? browser
                  ? t("settings.notifications.browser.turnOn.descriptionAsk")
                  : t("settings.notifications.turnOn.descriptionAsk")
                : t("settings.notifications.turnOn.descriptionOpen")
            }
          >
            <div className="settings-row__actions">
              {showAskMacOs ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onRequestNotificationPermission}
                >
                  {browser
                    ? t("settings.notifications.browser.turnOn.ask")
                    : t("settings.notifications.turnOn.ask")}
                </button>
              ) : null}
              {showOpenSystemSettings ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onOpenSystemNotificationSettings}
                >
                  {t("settings.notifications.turnOn.openSettings")}
                </button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.notifications.groupInApp")}
        description={
          browser
            ? t("settings.notifications.browser.groupInApp.description")
            : t("settings.notifications.groupInApp.description")
        }
      >
        <SettingsRow
          title={t("settings.notifications.completion.title")}
          description={t("settings.notifications.completion.description")}
        >
          <SettingsSwitch
            checked={notificationPreferences.backgroundCompletion}
            label={t("settings.notifications.completion.title")}
            onChange={(checked) => onSetNotificationPreferences({ backgroundCompletion: checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.notifications.failures.title")}
          description={t("settings.notifications.failures.description")}
        >
          <SettingsSwitch
            checked={notificationPreferences.backgroundFailure}
            label={t("settings.notifications.failures.title")}
            onChange={(checked) => onSetNotificationPreferences({ backgroundFailure: checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.notifications.attention.title")}
          description={t("settings.notifications.attention.description")}
        >
          <SettingsSwitch
            checked={notificationPreferences.attentionNeeded}
            label={t("settings.notifications.attention.title")}
            onChange={(checked) => onSetNotificationPreferences({ attentionNeeded: checked })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function labelForPermissionStatus(
  t: Translate,
  status: DesktopNotificationPermissionStatus,
): string {
  switch (status) {
    case "granted":
      return t("settings.notifications.access.enabled");
    case "denied":
      return t("settings.notifications.access.turnedOff");
    case "default":
      return t("settings.notifications.access.notEnabled");
    case "unsupported":
      return t("settings.notifications.access.unavailable");
    default:
      return t("settings.notifications.access.checking");
  }
}

function descriptionForPermissionStatus(
  t: Translate,
  status: DesktopNotificationPermissionStatus,
  browser: boolean,
): string {
  if (browser) {
    switch (status) {
      case "granted":
        return t("settings.notifications.browser.access.descriptionGranted");
      case "denied":
        return t("settings.notifications.browser.access.descriptionDenied");
      case "default":
        return t("settings.notifications.browser.access.descriptionDefault");
      case "unsupported":
        return t("settings.notifications.browser.access.descriptionUnsupported");
      default:
        break;
    }
  }
  switch (status) {
    case "granted":
      return t("settings.notifications.access.descriptionGranted");
    case "denied":
      return t("settings.notifications.access.descriptionDenied");
    case "default":
      return t("settings.notifications.access.descriptionDefault");
    case "unsupported":
      return t("settings.notifications.access.descriptionUnsupported");
    default:
      return t("settings.notifications.access.descriptionChecking");
  }
}
