// @effect-diagnostics nodeBuiltinImport:off -- Pure subprocess boundary is abortable and directly tested without Effect runtime services.
/** Bounded local conversion. Only the private processing worker supplies input paths. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export interface PreviewOutput {
  kind: "preview" | "poster";
  path: string;
  mimeType: string;
}

export function previewCommands(input: string, directory: string, mimeType: string) {
  const common = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov,matroska,webm,avi,mpeg,mpegts,image2,png_pipe,jpeg_pipe,gif,webp_pipe,heif,mp3,wav,flac,ogg,aac,ppm_pipe",
    "-threads",
    "2",
    "-i",
    input,
  ];
  if (mimeType.startsWith("video/"))
    return [
      {
        kind: "preview" as const,
        path: NodePath.join(directory, "preview.mp4"),
        mimeType: "video/mp4",
        args: [
          ...common,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-vf",
          "scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "25",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-map_metadata",
          "-1",
          "-movflags",
          "+faststart",
          "-fs",
          "262144000",
        ],
      },
      {
        kind: "poster" as const,
        path: NodePath.join(directory, "poster.jpg"),
        mimeType: "image/jpeg",
        args: [
          ...common,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale=960:960:force_original_aspect_ratio=decrease",
          "-map_metadata",
          "-1",
          "-fs",
          "10485760",
        ],
      },
    ];
  if (mimeType.startsWith("image/"))
    return [
      {
        kind: "preview" as const,
        path: NodePath.join(directory, "preview.png"),
        mimeType: "image/png",
        args: [
          ...common,
          "-frames:v",
          "1",
          "-pix_fmt",
          "rgba",
          "-vf",
          "scale=w='min(1536,iw)':h='min(1536,ih)':force_original_aspect_ratio=decrease",
          "-map_metadata",
          "-1",
          "-fs",
          "262144000",
        ],
      },
    ];
  if (mimeType.startsWith("audio/"))
    return [
      {
        kind: "preview" as const,
        path: NodePath.join(directory, "preview.m4a"),
        mimeType: "audio/mp4",
        args: [
          ...common,
          "-map",
          "0:a:0",
          "-vn",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-map_metadata",
          "-1",
          "-movflags",
          "+faststart",
          "-fs",
          "262144000",
        ],
      },
    ];
  throw new Error("This file has no supported preview conversion.");
}

/** Abort kills only the subprocess created here; no shell or user-controlled options. */
export function runPreviewCommand(args: readonly string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("ffmpeg", [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      signal,
      timeout: 240_000,
      killSignal: "SIGKILL",
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-2000);
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Preview conversion failed (${code ?? "stopped"}). ${diagnostic}`));
    });
  });
}
