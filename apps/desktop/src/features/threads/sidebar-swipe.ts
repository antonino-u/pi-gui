import { useEffect, useLayoutEffect, useRef } from "react";
import { hasHostScreen } from "../../lib/surface";
import { NARROW_SIDEBAR_QUERY, useMediaQuery } from "./sidebar-drawer";

/** A swipe that starts this close to the left edge opens the drawer. */
const EDGE_PX = 28;
/** Movement before the gesture commits to an axis; a vertical one is left to scrolling. */
const AXIS_LOCK_PX = 10;
/** A release faster than this (px/ms) decides by direction instead of distance. */
const FLING_VELOCITY = 0.35;
const SETTLE_MS = 220;

export interface SidebarSwipeCommands {
  readonly expandPrimarySidebar: () => void;
  readonly collapsePrimarySidebar: () => void;
}

interface Gesture {
  readonly mode: "open" | "close";
  readonly startX: number;
  readonly startY: number;
  axis: "pending" | "x";
  width: number;
  offset: number;
  lastX: number;
  lastTime: number;
  velocity: number;
}

/**
 * Drives the sidebar drawer with touch, like a phone app's side menu: a swipe from the left
 * edge pulls it in under the finger, a swipe left on it (or its backdrop) pushes it away, and a
 * release settles it open or closed by distance and speed. Opening from the toggle slides it in.
 *
 * The drawer's position lives in two variables on the document root (`--pi-drawer-offset`,
 * `--pi-drawer-progress`) while `data-pi-drawer` is set, so a sidebar that mounts mid-gesture
 * starts where the finger is instead of flashing fully open.
 *
 * Only a paired browser at the drawer breakpoint uses it; the desktop window keeps its
 * pointer-only drawer.
 */
export function useSidebarSwipe(
  toggleVisible: boolean,
  open: boolean,
  commands: SidebarSwipeCommands,
): void {
  const narrow = useMediaQuery(NARROW_SIDEBAR_QUERY);
  const enabled = toggleVisible && narrow && !hasHostScreen();
  const latest = useRef({
    open,
    onOpen: commands.expandPrimarySidebar,
    onClose: commands.collapsePrimarySidebar,
  });
  latest.current = {
    open,
    onOpen: commands.expandPrimarySidebar,
    onClose: commands.collapsePrimarySidebar,
  };
  const gestureRef = useRef<Gesture | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;

    const drawerWidth = () => {
      const width = document.querySelector(".shell > .sidebar")?.getBoundingClientRect().width;
      return width && width > 0 ? width : Math.min(window.innerWidth * 0.86, 360);
    };
    const place = (offset: number, width: number, phase: "drag" | "settle") => {
      root.dataset.piDrawer = phase;
      root.style.setProperty("--pi-drawer-offset", `${offset}px`);
      root.style.setProperty("--pi-drawer-progress", String(Math.max(0, 1 + offset / width)));
    };
    const settle = (toOpen: boolean, width: number) => {
      clearTimeout(settleTimer.current);
      place(toOpen ? 0 : -width, width, "settle");
      settleTimer.current = setTimeout(() => {
        if (toOpen) {
          clearDrawerPosition();
        } else {
          // The variables keep the drawer off screen until it unmounts; the open effect clears them.
          latest.current.onClose();
          settleTimer.current = setTimeout(clearDrawerPosition, 1_000);
        }
      }, SETTLE_MS);
    };

    const onStart = (event: TouchEvent) => {
      gestureRef.current = null;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      const target = event.target instanceof Element ? event.target : null;
      const mode = latest.current.open ? "close" : "open";
      if (mode === "open" && touch.clientX > EDGE_PX) return;
      if (mode === "close" && !target?.closest(".sidebar, .sidebar-drawer-backdrop")) return;
      gestureRef.current = {
        mode,
        startX: touch.clientX,
        startY: touch.clientY,
        axis: "pending",
        width: drawerWidth(),
        offset: mode === "open" ? -drawerWidth() : 0,
        lastX: touch.clientX,
        lastTime: event.timeStamp,
        velocity: 0,
      };
    };

    const onMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      const touch = event.touches[0];
      if (!gesture || !touch) return;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (gesture.axis === "pending") {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        const towardMenu = gesture.mode === "open" ? dx > 0 : dx < 0;
        if (!horizontal || !towardMenu) {
          gestureRef.current = null;
          return;
        }
        gesture.axis = "x";
        clearTimeout(settleTimer.current);
        if (gesture.mode === "open") latest.current.onOpen();
      }
      // Keep the page from scrolling or the browser from navigating while the drawer moves.
      if (event.cancelable) event.preventDefault();
      const elapsed = Math.max(1, event.timeStamp - gesture.lastTime);
      gesture.velocity = (touch.clientX - gesture.lastX) / elapsed;
      gesture.lastX = touch.clientX;
      gesture.lastTime = event.timeStamp;
      const base = gesture.mode === "open" ? dx - gesture.width : dx;
      gesture.offset = Math.min(0, Math.max(-gesture.width, base));
      place(gesture.offset, gesture.width, "drag");
    };

    const onEnd = () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture || gesture.axis !== "x") return;
      const progress = 1 + gesture.offset / gesture.width;
      const toOpen =
        gesture.velocity > FLING_VELOCITY
          ? true
          : gesture.velocity < -FLING_VELOCITY
            ? false
            : progress > 0.5;
      settle(toOpen, gesture.width);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
      clearTimeout(settleTimer.current);
      clearDrawerPosition();
    };
  }, [enabled]);

  // Opening from the toggle (not a swipe) slides the drawer in from the edge; a closed drawer
  // drops any position left from the gesture that closed it.
  useLayoutEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!enabled) return;
    if (!open) {
      if (document.documentElement.dataset.piDrawer && !gestureRef.current) {
        clearTimeout(settleTimer.current);
        clearDrawerPosition();
      }
      return;
    }
    if (!opened || gestureRef.current || document.documentElement.dataset.piDrawer) return;
    const root = document.documentElement;
    const width = document.querySelector(".shell > .sidebar")?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    root.dataset.piDrawer = "drag";
    root.style.setProperty("--pi-drawer-offset", `${-width}px`);
    root.style.setProperty("--pi-drawer-progress", "0");
    const frame = requestAnimationFrame(() => {
      root.dataset.piDrawer = "settle";
      root.style.setProperty("--pi-drawer-offset", "0px");
      root.style.setProperty("--pi-drawer-progress", "1");
      settleTimer.current = setTimeout(clearDrawerPosition, SETTLE_MS);
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, open]);
}

function clearDrawerPosition(): void {
  const root = document.documentElement;
  delete root.dataset.piDrawer;
  root.style.removeProperty("--pi-drawer-offset");
  root.style.removeProperty("--pi-drawer-progress");
}
