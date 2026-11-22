import { fileContentUrl } from "../files/file-client";

/** The streamed image URL, or null until the card scrolls into view. */
export function useArtifactImage(artifactId: string, enabled = true): string | null {
  return enabled ? fileContentUrl(artifactId) : null;
}
