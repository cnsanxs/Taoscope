import { useEffect, useMemo } from "react";
import { DataSourceProvider } from "@/datasource/context";
import { createDataSource } from "@/datasource/factory";
import { subscribeConnectionEvents } from "@/lib/connectionEvents";
import { useUpdater } from "@/lib/updater";
import { useAppState } from "@/store/appState";
import { TitleBar } from "@/components/layout/TitleBar";
import { ResourcesPanel } from "@/components/layout/ResourcesPanel";
import { ConsolesPanel } from "@/components/console/ConsolesPanel";
import { Editor } from "@/components/console/Editor";
import { ResultPanel } from "@/components/console/ResultPanel";
import { Toolbar } from "@/components/console/Toolbar";
import { ConsoleShortcuts } from "@/components/keyboard/ConsoleShortcuts";
import { ConfirmRoot } from "@/components/ui/ConfirmRoot";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";

function App() {
  const dataSource = useMemo(() => createDataSource(), []);
  const setConsoles = useAppState((s) => s.setConsoles);
  const checkForUpdate = useUpdater((s) => s.checkForUpdate);

  useEffect(() => {
    let cancelled = false;
    dataSource.listConsoles().then((list) => {
      if (cancelled) return;
      setConsoles(list);
    });
    return () => {
      cancelled = true;
    };
  }, [dataSource, setConsoles]);

  // One silent update probe per cold start. Errors are swallowed (no network,
  // no published release yet, etc.) so the status bar stays clean for first
  // launches; a manual click in StatusBar always re-checks loudly.
  useEffect(() => {
    void checkForUpdate({ silent: true });
  }, [checkForUpdate]);

  // Subscribe to backend reconnect lifecycle events for the lifetime of the
  // app. Outside Tauri the subscriber is a noop and tears down cleanly.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void subscribeConnectionEvents().then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Suppress the default browser context menu globally — the webview shouldn't
  // expose "Inspect / View Source" in a desktop app. shadcn ContextMenu (Radix)
  // calls preventDefault inside its own onContextMenu before this bubble-phase
  // listener fires, so explicit triggers still open their menus.
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  return (
    <DataSourceProvider value={dataSource}>
      <div className="bg-surface-0 flex h-screen w-screen flex-col overflow-hidden bg-[radial-gradient(140%_140%_at_0%_0%,hsl(220_7%_16%)_0%,hsl(220_9%_10%)_45%,hsl(220_10%_7%)_100%)]">
        <TitleBar />
        <div className="flex min-h-0 flex-1 gap-1.5 px-1.5 pb-1.5">
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="resources-main"
          >
            <ResizablePanel
              defaultSize={20}
              minSize={15}
              maxSize={40}
            >
              <ResourcesPanel />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={80}>
              <ResizablePanelGroup
                direction="vertical"
                autoSaveId="right-vertical"
              >
                <ResizablePanel defaultSize={55} minSize={20}>
                  <ResizablePanelGroup
                    direction="horizontal"
                    autoSaveId="editor-consoles"
                  >
                    <ResizablePanel defaultSize={75} minSize={40}>
                      <div className="border-border/70 bg-card focus-within:border-primary/50 flex h-full min-h-0 flex-col overflow-hidden rounded-lg border shadow-[0_4px_16px_-4px_rgba(0,0,0,0.45),inset_0_1px_0_0_hsl(0_0%_100%/0.05)] transition-colors">
                        <Toolbar />
                        <Editor />
                      </div>
                    </ResizablePanel>
                    <ResizableHandle />
                    <ResizablePanel
                      defaultSize={25}
                      minSize={12}
                      maxSize={45}
                    >
                      <ConsolesPanel />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize={45} minSize={15}>
                  <ResultPanel />
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        <Toaster richColors position="bottom-right" />
        <ConfirmRoot />
        <ConsoleShortcuts />
      </div>
    </DataSourceProvider>
  );
}

export default App;
