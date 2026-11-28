/**
 * The link as it is sent, when it is an https address without credentials; anything else is no
 * link at all. Internet links clients draw come through here, so a card that carries one never
 * sends a person to a plaintext address or one that carries a password.
 *
 * Kept out of `egress.ts`, whose suffix-list dependency only policy code should load.
 */
export function httpsUrl(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" && !url.username && !url.password ? input.trim() : undefined;
  } catch {
    return undefined;
  }
}
