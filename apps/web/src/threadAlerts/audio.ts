import { randomUUID } from "../lib/utils";
import type { AlertDeliverySettings } from "@spiritdevs/contracts/threadAlerts";
import { deleteAlertSound, readAlertSound, saveAlertSound } from "./storage";

export const BUILT_IN_ALERT_SOUNDS = [
  { id: "default", label: "Pathway default" },
  { id: "system", label: "System default" },
  { id: "chime", label: "Chime" },
  { id: "gentle", label: "Gentle" },
] as const;

let context: AudioContext | undefined;
let active: AudioBufferSourceNode | undefined;
let playbackRevision = 0;
function audioContext() {
  if (typeof AudioContext === "undefined")
    throw new Error("Audio playback is unsupported in this browser.");
  return (context ??= new AudioContext());
}

export function validateAlertSoundFile(file: Pick<File, "name" | "size" | "type">): void {
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose an audio file no larger than 5 MB.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  const formats: Record<string, readonly string[]> = {
    mp3: ["audio/mpeg", "audio/mp3"],
    wav: ["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"],
    m4a: ["audio/mp4", "audio/m4a", "audio/x-m4a"],
    ogg: ["audio/ogg", "application/ogg"],
    webm: ["audio/webm", "video/webm"],
  };
  const accepted = extension ? formats[extension] : undefined;
  if (!accepted || (file.type && !accepted.includes(file.type.toLowerCase()))) {
    throw new Error("Choose an MP3, WAV, M4A, OGG, or WebM audio file.");
  }
}

export async function saveCustomAlertSound(file: File) {
  validateAlertSoundFile(file);
  let decoded: AudioBuffer;
  try {
    decoded = await audioContext().decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("This audio file could not be decoded. Choose another file.");
  }
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 10) {
    throw new Error("Choose an audio file no longer than 10 seconds.");
  }
  const id = randomUUID();
  await saveAlertSound(id, file);
  return { id, name: file.name, mimeType: file.type, size: file.size, duration: decoded.duration };
}

export const removeCustomAlertSound = deleteAlertSound;

/** Built-in tones share the custom-file playback path and release their buffers after playing. */
function builtInBuffer(audio: AudioContext, soundId: string): AudioBuffer {
  const duration = soundId === "gentle" ? 0.45 : 0.65;
  const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * duration), audio.sampleRate);
  const samples = buffer.getChannelData(0);
  const frequency = soundId === "chime" ? 880 : soundId === "gentle" ? 440 : 660;
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / audio.sampleRate;
    const envelope = Math.min(1, t / 0.015) * Math.exp(-t * 9) * Math.min(1, (duration - t) / 0.03);
    samples[i] = Math.sin(2 * Math.PI * frequency * t) * envelope * 0.2;
  }
  return buffer;
}

export function stopAlertSound(): void {
  playbackRevision += 1;
  active?.stop();
  active?.disconnect();
  active = undefined;
}

export async function previewAlertSound(settings: AlertDeliverySettings): Promise<void> {
  stopAlertSound();
  const revision = playbackRevision;
  let useSystem = settings.soundId === "system";
  let bytes: Blob | undefined;
  if (settings.soundId === "custom" || settings.soundId === settings.customSound?.id) {
    if (settings.customSound) bytes = await readAlertSound(settings.customSound.id);
    if (!bytes) useSystem = true;
  }
  if (revision !== playbackRevision) return;
  if (useSystem && window.desktopBridge?.threadAlerts) {
    try {
      await window.desktopBridge.threadAlerts.playSystemSound();
      return;
    } catch {
      /* A platform without an alert sound uses the Pathway tone. */
    }
  }
  const audio = audioContext();
  if (audio.state === "suspended") await audio.resume();
  const buffer = bytes
    ? await audio.decodeAudioData(await bytes.arrayBuffer())
    : builtInBuffer(audio, settings.soundId);
  if (revision !== playbackRevision) return;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = false;
  source.connect(audio.destination);
  source.addEventListener("ended", () => {
    source.disconnect();
    source.buffer = null;
    if (active === source) active = undefined;
  });
  active = source;
  source.start();
}

/** A user gesture unlocks Web Audio for later automatic alerts. */
export function unlockAlertAudio(): void {
  try {
    const audio = audioContext();
    if (audio.state === "suspended") void audio.resume().catch(() => {});
  } catch {
    /* Settings reports unsupported audio when the user previews it. */
  }
}
