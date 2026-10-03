// Frame boundaries are explicit so ordinary ASCII rules/boxes stay intact.
export function asciiFrames(code: string, animated: boolean): string[] {
  if (!animated) return [code];
  const frames = code.replace(/\r\n?/g, "\n").split(/^---frame---[ \t]*$/m);
  // Bound playback work for large agent outputs; source remains available unchanged.
  if (frames.length > 120 || code.length > 100_000) return [code];
  return frames.map((frame) => frame.replace(/^\n|\n$/g, ""));
}
