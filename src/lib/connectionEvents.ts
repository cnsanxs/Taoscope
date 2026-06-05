/**
 * Subscribe to the backend's reconnect lifecycle events.
 *
 * The Rust `ws_client::with_reconnect` wrapper emits three Tauri events for
 * every reconnect cycle. We forward them into:
 *   - `connectionRuntime[connId].reconnecting` (drives the amber badge state)
 *   - `connection.status` (set to `offline` when reconnect ultimately fails)
 *   - `sonner` toasts so the user gets a discoverable hint that something
 *     happened in the background.
 *
 * No-ops outside Tauri so storybook / unit tests / web preview don't crash
 * trying to `listen` against a missing IPC bridge.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { isTauriRuntime } from "@/datasource/factory";
import { useAppState } from "@/store/appState";

interface ReconnectPayload {
  connId: string;
}

interface ReconnectFailedPayload {
  connId: string;
  error: string;
}

function toastIdFor(connId: string): string {
  return `reconnect-${connId}`;
}

function tConnection(key: string, opts?: Record<string, unknown>): string {
  // i18n may still be initialising on first paint; the t() call still returns
  // the key string in that window — acceptable, the toast just shows the raw
  // key briefly. Normal flow: this is invoked long after init in App.tsx.
  return i18n.t(`toast.${key}`, { ns: "connection", ...(opts ?? {}) }) as string;
}

export async function subscribeConnectionEvents(): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    // No-op outside Tauri; the returned unlistener is a noop too.
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const setReconnecting = useAppState.getState().setReconnecting;
  const setConnectionStatus = useAppState.getState().setConnectionStatus;

  const unlistenReconnecting = await listen<ReconnectPayload>(
    "connection:reconnecting",
    (e) => {
      const { connId } = e.payload;
      setReconnecting(connId, true);
      toast.loading(tConnection("reconnecting"), { id: toastIdFor(connId) });
    },
  );

  const unlistenReconnected = await listen<ReconnectPayload>(
    "connection:reconnected",
    (e) => {
      const { connId } = e.payload;
      setReconnecting(connId, false);
      toast.success(tConnection("reconnected"), {
        id: toastIdFor(connId),
        duration: 2000,
      });
    },
  );

  const unlistenFailed = await listen<ReconnectFailedPayload>(
    "connection:reconnect-failed",
    (e) => {
      const { connId, error } = e.payload;
      setReconnecting(connId, false);
      setConnectionStatus(connId, "offline");
      toast.error(tConnection("reconnect-failed", { error }), {
        id: toastIdFor(connId),
        duration: 6000,
      });
    },
  );

  return () => {
    unlistenReconnecting();
    unlistenReconnected();
    unlistenFailed();
  };
}
