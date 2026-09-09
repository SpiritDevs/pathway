import { DEFAULT_CLIENT_SETTINGS } from "@spiritdevs/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistence = vi.hoisted(() => ({ getClientSettings: vi.fn(), setClientSettings: vi.fn() }));
vi.mock("../localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
import {
  __resetClientSettingsPersistenceForTests,
  getClientSettings,
  persistClientSettingsPatch,
} from "./useSettings";

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  persistence.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

describe("native capture settings persistence", () => {
  it("hydrates existing preferences before saving an opt-in patch", async () => {
    persistence.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotPlaySound: false,
    });
    await persistClientSettingsPatch({ snapShotEnabled: true });
    expect(persistence.setClientSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ snapShotEnabled: true, snapShotPlaySound: false }),
    );
  });

  it("waits for the native write and serializes subsequent patches", async () => {
    const entered = deferred();
    const saved = deferred();
    persistence.setClientSettings.mockImplementationOnce(async () => {
      entered.resolve();
      await saved.promise;
    });
    const first = persistClientSettingsPatch({ snapShotEnabled: true });
    let completed = false;
    void first.then(() => {
      completed = true;
    });
    const second = persistClientSettingsPatch({ snapShotPlaySound: false });
    await entered.promise;
    expect(completed).toBe(false);
    expect(persistence.setClientSettings).toHaveBeenCalledTimes(1);
    saved.resolve();
    await Promise.all([first, second]);
    expect(persistence.setClientSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapShotEnabled: true, snapShotPlaySound: false }),
    );
  });

  it("reports failed native writes, restores saved preferences and permits a retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      persistence.setClientSettings.mockRejectedValueOnce(new Error("read only"));
      await expect(persistClientSettingsPatch({ snapShotEnabled: true })).rejects.toThrow(
        "read only",
      );
      expect(getClientSettings().snapShotEnabled).toBe(false);
      await persistClientSettingsPatch({ snapShotEnabled: true });
      expect(persistence.setClientSettings.mock.calls.at(-1)?.[0]).toMatchObject({
        snapShotEnabled: true,
      });
      expect(getClientSettings().snapShotEnabled).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
