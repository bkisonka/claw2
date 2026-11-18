import { Capacitor } from "@capacitor/core";

/** True inside the packaged native app (Android/iOS); false in browsers / hosted PWA. */
export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}
