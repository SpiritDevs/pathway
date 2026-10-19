import { expect, it } from "vite-plus/test";
import { deviceModel } from "./deviceModels";
it("recognizes a renamed Duo from native capabilities instead of the user label", () => {
  expect(deviceModel("ios", "My test device", true)?.id).toBe("iphone-duo");
  expect(deviceModel("ios", "iPhone Duo")?.id).toBe("iphone-duo");
  expect(deviceModel("ios", "My test device")).toBeNull();
  expect(deviceModel("android", "My test device", true)).toBeNull();
});
