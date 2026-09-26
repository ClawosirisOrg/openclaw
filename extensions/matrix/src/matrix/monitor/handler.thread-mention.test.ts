import { beforeEach, describe, expect, it } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

beforeEach(() => {
  installMatrixMonitorTestRuntime();
});

describe("Matrix thread root mention continuation", () => {
  it("accepts an unmentioned thread reply when the human-authored root mentioned the bot", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$root",
            sender: "@alice:example.org",
            body: "@bot start thread",
          }),
      },
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "follow up without another mention",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:ops:main:thread:$root" }),
    );
  });

  it("does not give configured bot descendants implicit access from a mentioned thread root", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$root",
            sender: "@alice:example.org",
            body: "@bot start thread",
          }),
      },
      isDirectMessage: false,
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@relaybot:example.org"]),
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply-from-bot",
        sender: "@relaybot:example.org",
        body: "automated follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });
});
