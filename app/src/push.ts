import { Platform } from "react-native";
import type { Api } from "./api";

// Web Push for the installed web app (Android, desktop, and iPhone once
// Cortile is added to the Home Screen).

export type PushState = "unsupported" | "needs-install" | "default" | "granted" | "denied";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushState(): PushState {
  if (Platform.OS !== "web" || typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window) || typeof Notification === "undefined") {
    // iPhone Safari only offers push to apps added to the Home Screen.
    return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  }
  return Notification.permission as PushState;
}

export function registerServiceWorker() {
  if (Platform.OS !== "web" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function base64ToBytes(base64: string) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// Must run from a tap: browsers only show the permission prompt for a user gesture.
export async function enablePush(api: Api): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission as PushState;
  await syncPush(api);
  return "granted";
}

// Makes sure the server has this device's current subscription.
export async function syncPush(api: Api) {
  if (pushState() !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api.pushKey();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) });
  }
  await api.pushSubscribe(sub.toJSON());
}

// On logout this device stops receiving the account's notifications.
export async function disablePush(api: Api) {
  if (pushState() === "unsupported" || pushState() === "needs-install") return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
