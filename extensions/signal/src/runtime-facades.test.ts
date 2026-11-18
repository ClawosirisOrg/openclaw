import { describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => undefined),
  monitorSignalProvider: vi.fn(async () => undefined),
  probeSignal: vi.fn(async () => ({ ok: true, status: 200, elapsedMs: 1 })),
  probeSignalAccount: vi.fn(async () => ({ ok: true, status: 200, elapsedMs: 1 })),
}));

vi.mock("./monitor.runtime.js", () => ({
  deliverReplies: runtimeMocks.deliverReplies,
  monitorSignalProvider: runtimeMocks.monitorSignalProvider,
}));

vi.mock("./probe.runtime.js", () => ({
  probeSignal: runtimeMocks.probeSignal,
  probeSignalAccount: runtimeMocks.probeSignalAccount,
}));

import { monitorSignalProvider } from "./monitor.js";
import { probeSignal, probeSignalAccount } from "./probe.js";

describe("Signal public runtime facades", () => {
  it("delegates the public monitor entry point to the lazy runtime owner", async () => {
    const options = { autoStart: false };

    await monitorSignalProvider(options);

    expect(runtimeMocks.monitorSignalProvider).toHaveBeenCalledWith(options);
  });

  it("delegates both public probe entry points to the lazy runtime owner", async () => {
    const accountProbe = {
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      transportKind: "container" as const,
      account: "+15555550123",
    };

    await probeSignal(accountProbe.baseUrl, accountProbe.timeoutMs, {
      transportKind: accountProbe.transportKind,
    });
    await probeSignalAccount(accountProbe);

    expect(runtimeMocks.probeSignal).toHaveBeenCalledWith(
      accountProbe.baseUrl,
      accountProbe.timeoutMs,
      { transportKind: accountProbe.transportKind },
    );
    expect(runtimeMocks.probeSignalAccount).toHaveBeenCalledWith(accountProbe);
  });
});
