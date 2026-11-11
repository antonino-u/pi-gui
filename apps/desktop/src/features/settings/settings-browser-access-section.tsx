import { useCallback, useEffect, useState } from "react";
import type {
  BrowserAccessStatus,
  BrowserDeviceInfo,
  BrowserPairingCode,
} from "../../../contracts/browser-access";
import { useTranslation } from "../../i18n";
import { formatRelativeTime } from "../../lib/string-utils";
import { CopyIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/** How often the page refreshes which devices are connected while it is open. */
const REFRESH_MS = 5_000;

function formatCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Settings > Browser access: where browsers on other devices reach this app, the devices
 * paired with it, and a one-time code (with a QR code) that pairs one more.
 */
export function SettingsBrowserAccessSection() {
  const { t } = useTranslation();
  const api = window.piApp;
  const [status, setStatus] = useState<BrowserAccessStatus | null>(null);
  const [pairing, setPairing] = useState<BrowserPairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(pairing !== null);

  const run = useCallback(<T,>(action: () => Promise<T>, apply: (value: T) => void) => {
    action().then(
      (value) => {
        setError(null);
        apply(value);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  const refresh = useCallback(() => {
    if (!api) return;
    run(() => api.getBrowserAccessStatus(), setStatus);
  }, [api, run]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!api || !status) return null;

  if (!status.enabled) {
    return (
      <SettingsGroup title={t("settings.browserAccess.groupStatus")}>
        <SettingsRow
          title={t("settings.browserAccess.off.title")}
          description={t("settings.browserAccess.off.description")}
        />
      </SettingsGroup>
    );
  }

  const remaining = pairing ? secondsLeft(pairing.expiresAt, now) : 0;
  const createCode = () => run(() => api.createBrowserPairingCode(), setPairing);
  const revoke = (device: BrowserDeviceInfo) => {
    if (!window.confirm(t("settings.browserAccess.revoke.confirm", { name: device.name }))) return;
    run(() => api.revokeBrowserDevice(device.id), setStatus);
  };
  const resetLink = () => {
    if (!window.confirm(t("settings.browserAccess.resetLink.confirm"))) return;
    run(() => api.resetBrowserPairingLink(), setStatus);
  };

  return (
    <>
      {error ? (
        <p className="settings-section__description" role="alert">
          {error}
        </p>
      ) : null}

      <SettingsGroup
        title={t("settings.browserAccess.groupStatus")}
        description={
          status.https
            ? t("settings.browserAccess.addresses.https")
            : t("settings.browserAccess.addresses.http")
        }
      >
        {status.addresses.map((address) => (
          <SettingsRow key={address} title={address}>
            <button
              aria-label={t("settings.browserAccess.copyAddress")}
              className="icon-button"
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(address).catch(() => undefined);
              }}
            >
              <CopyIcon />
            </button>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.browserAccess.groupPair")}
        description={t("settings.browserAccess.pair.description")}
      >
        {pairing && remaining > 0 ? (
          <div className="browser-access-pairing" data-testid="browser-access-pairing">
            <img
              alt={t("settings.browserAccess.pair.qrAlt")}
              className="browser-access-pairing__qr"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`}
            />
            <div className="browser-access-pairing__details">
              <div className="browser-access-pairing__code" data-testid="browser-access-code">
                {formatCode(pairing.code)}
              </div>
              <div className="settings-row__description">
                {t("settings.browserAccess.pair.expires", {
                  time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`,
                })}
              </div>
              <div className="settings-row__description">
                {t("settings.browserAccess.pair.orType", {
                  address: status.addresses[0] ?? "",
                })}
              </div>
            </div>
          </div>
        ) : (
          <SettingsRow
            title={t("settings.browserAccess.pair.title")}
            description={pairing ? t("settings.browserAccess.pair.expired") : undefined}
          >
            <button className="button button--secondary" type="button" onClick={createCode}>
              {t("settings.browserAccess.pair.action")}
            </button>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.browserAccess.groupDevices")}
        description={t("settings.browserAccess.devices.description")}
      >
        {status.devices.length === 0 ? (
          <SettingsRow title={t("settings.browserAccess.devices.none")} />
        ) : (
          status.devices.map((device) => (
            <SettingsRow
              key={device.id}
              title={
                device.connected
                  ? t("settings.browserAccess.devices.connected", { name: device.name })
                  : device.name
              }
              description={t("settings.browserAccess.devices.seen", {
                paired: new Date(device.pairedAt).toLocaleDateString(),
                seen: formatRelativeTime(device.lastSeenAt),
              })}
            >
              <button
                className="button button--secondary"
                data-testid="browser-access-revoke"
                type="button"
                onClick={() => revoke(device)}
              >
                {t("settings.browserAccess.revoke.action")}
              </button>
            </SettingsRow>
          ))
        )}
        <SettingsRow
          title={t("settings.browserAccess.resetLink.title")}
          description={t("settings.browserAccess.resetLink.description")}
        >
          <button className="button button--secondary" type="button" onClick={resetLink}>
            {t("settings.browserAccess.resetLink.action")}
          </button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
