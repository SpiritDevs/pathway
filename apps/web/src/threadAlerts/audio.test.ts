import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { saveCustomAlertSound, validateAlertSoundFile } from "./audio";
import { saveAlertSound } from "./storage";

vi.mock("./storage", () => ({
  saveAlertSound: vi.fn().mockResolvedValue(undefined),
  readAlertSound: vi.fn(),
  deleteAlertSound: vi.fn(),
}));
const decode = vi.fn();
class FakeAudioContext {
  decodeAudioData = decode;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("AudioContext", FakeAudioContext);
});
afterEach(() => vi.unstubAllGlobals());
const file = (name = "alert.mp3", type = "audio/mpeg", size = 1024) =>
  ({ name, type, size, arrayBuffer: async () => new ArrayBuffer(8) }) as File;

describe("custom alert audio validation", () => {
  it.each([
    ["alert.mp3", "audio/mpeg"],
    ["alert.wav", "audio/wav"],
    ["alert.m4a", "audio/mp4"],
    ["alert.ogg", "audio/ogg"],
    ["alert.webm", "audio/webm"],
  ])("accepts %s with matching MIME type", (name, type) => {
    expect(() => validateAlertSoundFile(file(name, type))).not.toThrow();
  });
  it("rejects oversized files before decoding or saving", async () => {
    await expect(
      saveCustomAlertSound(file("alert.mp3", "audio/mpeg", 5 * 1024 * 1024 + 1)),
    ).rejects.toThrow("5 MB");
    expect(decode).not.toHaveBeenCalled();
    expect(saveAlertSound).not.toHaveBeenCalled();
  });
  it("rejects mismatched MIME types and unsupported extensions", () => {
    expect(() => validateAlertSoundFile(file("alert.mp3", "image/png"))).toThrow("MP3");
    expect(() => validateAlertSoundFile(file("alert.exe", "audio/mpeg"))).toThrow("MP3");
  });
  it("rejects undecodable and overlong audio without saving", async () => {
    decode.mockRejectedValueOnce(new Error("decode failed"));
    await expect(saveCustomAlertSound(file())).rejects.toThrow("decoded");
    decode.mockResolvedValueOnce({ duration: 10.01 });
    await expect(saveCustomAlertSound(file())).rejects.toThrow("10 seconds");
    expect(saveAlertSound).not.toHaveBeenCalled();
  });
  it("decodes before saving original bytes for the installation", async () => {
    decode.mockResolvedValueOnce({ duration: 10 });
    const input = file();
    const saved = await saveCustomAlertSound(input);
    expect(saved).toMatchObject({
      name: "alert.mp3",
      mimeType: "audio/mpeg",
      duration: 10,
      size: 1024,
    });
    expect(saveAlertSound).toHaveBeenCalledWith(saved.id, input);
  });
});
