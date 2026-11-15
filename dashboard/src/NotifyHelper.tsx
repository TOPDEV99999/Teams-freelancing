import { useEffect, useState } from "react";
import { beep } from "./store";

/**
 * Desktop notifications only work when the browser allows them for this page. This shows the current
 * permission, lets you grant it with a click (browsers require a click), and sends a test.
 */
export default function NotifyHelper() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");
  useEffect(() => {
    if (!supported) return;
    const t = window.setInterval(() => setPerm(Notification.permission), 3000);
    return () => window.clearInterval(t);
  }, [supported]);

  const test = async () => {
    beep();
    if (!supported) return;
    let p = Notification.permission;
    if (p === "default") p = await Notification.requestPermission();
    setPerm(p);
    if (p === "granted") {
      new Notification("Workana Assistant — test", { body: "Desktop notifications work. New jobs and messages will appear like this." });
    }
  };

  if (perm === "unsupported") return <p className="text-[11px] text-rose-700">This browser has no desktop notifications.</p>;
  return (
    <div className="space-y-1 text-[11px]">
      {perm === "default" && (
        <button className="w-full rounded-md bg-amber-50 px-2 py-1 text-left font-medium text-amber-800 hover:bg-amber-100" onClick={test}>
          🔔 Click to allow desktop notifications
        </button>
      )}
      {perm === "denied" && (
        <p className="rounded-md bg-rose-50 px-2 py-1 text-rose-800">
          Notifications are <b>blocked</b> for this page. Click the icon left of the address bar → Notifications → Allow, then reload.
        </p>
      )}
      {perm === "granted" && (
        <button className="text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline" onClick={test}>Send a test notification</button>
      )}
    </div>
  );
}
