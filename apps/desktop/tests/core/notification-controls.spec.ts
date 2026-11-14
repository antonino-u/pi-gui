import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";
import {
  emitAttentionRequest,
  emitCompletedEvent,
  emitFailedEvent,
  emitRunningEvent,
  readOptionalLog,
} from "../helpers/notification-events";
import {
  createThread,
  selectSessionByTitle,
  setSessionVisibilityOverride,
  type SessionContext,
} from "../helpers/session-event-test-helpers";

const loggedBodies = async (path: string) =>
  (await readOptionalLog(path))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as { title: string; body: string };
      return `${entry.title}: ${entry.body}`;
    });

async function openRowMenu(window: Page, title: string) {
  const row = window.locator(".session-row", { hasText: title }).first();
  await row.click({ button: "right" });
  return { row, menu: row.getByRole("menu") };
}

/**
 * Notifications are handled in order, so a silenced event is proven silent by a later event
 * that does notify: when the later one is in the log, the earlier one would be too.
 */
test("mute, pause and quiet hours silence notifications, and persist", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications.jsonl");
  const workspacePath = await makeWorkspace("notification-controls-workspace");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    let window = await harness.firstWindow();
    const quiet = await createThread(window, "Quiet thread");
    const loud = await createThread(window, "Loud thread");
    await createThread(window, "Viewer thread");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Viewer thread");
    const complete = async (session: SessionContext, label: string) =>
      emitCompletedEvent(harness, session, label, await emitRunningEvent(harness, session, label));

    await test.step("a muted thread does not notify; others still do", async () => {
      const { row, menu } = await openRowMenu(window, "Quiet thread");
      await menu.getByRole("button", { name: "Mute notifications" }).click();
      await expect(row.getByTestId("session-row-muted")).toBeVisible();
      await complete(quiet, "Muted");
      await complete(loud, "Unmuted");
      await expect
        .poll(() => loggedBodies(notificationLogPath))
        .toEqual(["Loud thread: Agent finished responding"]);
    });

    await test.step("a pause silences everything, even a request for input", async () => {
      await window.evaluate(() => globalThis.window.piApp.setActiveView("settings"));
      await window.getByRole("button", { name: "Notifications" }).click();
      await window.getByLabel("Pause notifications").selectOption("indefinite");
      await expect(window.getByText("Notifications are paused")).toBeVisible();
      await emitAttentionRequest(harness, loud, "Paused", "Approve while paused");
      await window.getByTestId("notifications-resume").click();
      await expect(window.getByText("Notifications are paused")).toHaveCount(0);
      await emitFailedEvent(harness, loud, "Resumed", "Failed after resume");
      await expect
        .poll(() => loggedBodies(notificationLogPath))
        .toEqual(["Loud thread: Agent finished responding", "Loud thread: Failed after resume"]);
    });

    await test.step("quiet hours silence finished threads but not requests for input", async () => {
      const quietSwitch = window.getByRole("switch", { name: "Quiet hours" });
      await quietSwitch.click();
      await expect(quietSwitch).toBeChecked();
      // Equal start and end times cover the whole day, so the test does not depend on the clock.
      await window.getByLabel("From").fill("09:00");
      await window.getByLabel("To").fill("09:00");
      await expect(window.getByRole("group", { name: "Days" }).getByRole("button")).toHaveCount(7);
      await complete(loud, "Quiet");
      await emitAttentionRequest(harness, loud, "Quiet", "Approve during quiet hours");
      await expect
        .poll(() => loggedBodies(notificationLogPath))
        .toEqual([
          "Loud thread: Agent finished responding",
          "Loud thread: Failed after resume",
          "Loud thread: Approve during quiet hours",
        ]);
    });

    await test.step("mute and quiet hours survive a restart", async () => {
      await harness.close();
      harness = await launchDesktop(userDataDir, { notificationLogPath, testMode: "background" });
      window = await harness.firstWindow();
      const mutedAfterRestart = await window.evaluate(async () =>
        globalThis.window.piApp.getState().then((state) =>
          state.workspaces
            .flatMap((workspace) => workspace.sessions)
            .filter((session) => session.notificationsMuted)
            .map((session) => session.title),
        ),
      );
      expect(mutedAfterRestart).toEqual(["Quiet thread"]);
      // The app reopens on Settings, where it was left; the thread rows are in the sidebar.
      await window.evaluate(() => globalThis.window.piApp.setActiveView("threads"));
      await expect(
        window
          .locator(".session-row", { hasText: "Quiet thread" })
          .getByTestId("session-row-muted"),
      ).toBeVisible();
      const preferences = await window.evaluate(async () =>
        globalThis.window.piApp.getState().then((state) => state.notificationPreferences),
      );
      expect(preferences.quietHours).toMatchObject({ enabled: true, start: "09:00", end: "09:00" });
      expect(preferences.pause).toBeNull();

      const { row, menu } = await openRowMenu(window, "Quiet thread");
      await menu.getByRole("button", { name: "Unmute notifications" }).click();
      await expect(row.getByTestId("session-row-muted")).toHaveCount(0);
    });
  } finally {
    await harness.close();
  }
});
