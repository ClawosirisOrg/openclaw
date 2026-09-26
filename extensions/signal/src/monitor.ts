import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MonitorSignalOpts } from "./monitor.runtime.js";

export type { MonitorSignalOpts };

type SignalMonitorRuntime = typeof import("./monitor.runtime.js");
type DeliverRepliesParams = Parameters<SignalMonitorRuntime["deliverReplies"]>[0];

const loadSignalMonitorRuntime = createLazyRuntimeModule(() => import("./monitor.runtime.js"));

export async function deliverReplies(params: DeliverRepliesParams): Promise<void> {
  await (await loadSignalMonitorRuntime()).deliverReplies(params);
}

export async function monitorSignalProvider(opts: MonitorSignalOpts = {}): Promise<void> {
  await (await loadSignalMonitorRuntime()).monitorSignalProvider(opts);
}
