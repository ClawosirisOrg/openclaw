import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export type SignalProbe = import("./probe.runtime.js").SignalProbe;
type SignalProbeOptions = import("./probe.runtime.js").SignalProbeOptions;
type ProbeSignalAccountParams = Parameters<
  typeof import("./probe.runtime.js").probeSignalAccount
>[0];

const loadSignalProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  options: SignalProbeOptions = {},
): Promise<SignalProbe> {
  return await (await loadSignalProbeRuntime()).probeSignal(baseUrl, timeoutMs, options);
}

export async function probeSignalAccount(params: ProbeSignalAccountParams): Promise<SignalProbe> {
  return await (await loadSignalProbeRuntime()).probeSignalAccount(params);
}
