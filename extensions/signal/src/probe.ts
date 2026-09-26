import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { SignalProbe } from "./probe.runtime.js";

export type { SignalProbe };

type SignalProbeRuntime = typeof import("./probe.runtime.js");
type SignalProbeOptions = Parameters<SignalProbeRuntime["probeSignal"]>[2];
type SignalProbeAccountParams = Parameters<SignalProbeRuntime["probeSignalAccount"]>[0];

const loadSignalProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  options: SignalProbeOptions = {},
): Promise<SignalProbe> {
  return await (await loadSignalProbeRuntime()).probeSignal(baseUrl, timeoutMs, options);
}

export async function probeSignalAccount(params: SignalProbeAccountParams): Promise<SignalProbe> {
  return await (await loadSignalProbeRuntime()).probeSignalAccount(params);
}
