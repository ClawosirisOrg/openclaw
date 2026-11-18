import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export type MonitorSignalOpts = import("./monitor.runtime.js").MonitorSignalOpts;
type DeliverRepliesParams = Parameters<typeof import("./monitor.runtime.js").deliverReplies>[0];

const loadSignalMonitorRuntime = createLazyRuntimeModule(() => import("./monitor.runtime.js"));

export async function deliverReplies(params: DeliverRepliesParams) {
  return await (await loadSignalMonitorRuntime()).deliverReplies(params);
}

export async function monitorSignalProvider(opts: MonitorSignalOpts = {}): Promise<void> {
  return await (await loadSignalMonitorRuntime()).monitorSignalProvider(opts);
}
