/** Maps a click in an aspect-fitted image to the browser's CSS viewport. */
export function remoteBrowserPoint(input: {
  x: number;
  y: number;
  boxWidth: number;
  boxHeight: number;
  width: number;
  height: number;
}): { x: number; y: number } | null {
  if (input.width <= 0 || input.height <= 0 || input.boxWidth <= 0 || input.boxHeight <= 0)
    return null;
  const scale = Math.min(input.boxWidth / input.width, input.boxHeight / input.height);
  const x = (input.x - (input.boxWidth - input.width * scale) / 2) / scale;
  const y = (input.y - (input.boxHeight - input.height * scale) / 2) / scale;
  return x >= 0 && y >= 0 && x < input.width && y < input.height ? { x, y } : null;
}
