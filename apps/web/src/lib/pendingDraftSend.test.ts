import { describe, expect, it } from "vite-plus/test";

import { pendingDraftSendHold } from "./pendingDraftSend";

const environment = (phase: string) => ({ label: "Macbook Pro M1", connection: { phase } });

describe("pendingDraftSendHold", () => {
  it("keeps a send to a connected environment working", () => {
    expect(pendingDraftSendHold(environment("connected"))).toBeNull();
  });

  it.each(["disconnected", "connecting"])(
    "names the %s environment a send is waiting for",
    (phase) => {
      expect(pendingDraftSendHold(environment(phase))?.title).toBe("Waiting for Macbook Pro M1");
    },
  );

  it("waits honestly when the environment is unknown to this client", () => {
    expect(pendingDraftSendHold(null)).toMatchObject({
      title: "Waiting for environment",
      description: expect.stringContaining("This chat's environment is not connected."),
    });
  });
});
