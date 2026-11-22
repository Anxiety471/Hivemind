import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { Actor } from "@rakazo/contracts";
import { MOBILE_APP_ANDROID_DOWNLOAD_PATH } from "@rakazo/contracts";
import type { Hono } from "hono";

/**
 * `GET /api/account/mobile-app/android`: this deployment's signed Android build, streamed only
 * to a signed-in account. `me.mobileApp.android` points here when MOBILE_APP_ANDROID_FILE names
 * the APK on disk, so the build never needs a public URL. A missing file is a 404, not a crash.
 */
export function mountMobileAppDownloadRoute(
  app: Hono,
  deps: { sessionActor: (request: Request) => Promise<Actor | null>; filePath?: string },
): void {
  const notFound = { "cache-control": "no-store" };
  app.on(["GET", "HEAD"], MOBILE_APP_ANDROID_DOWNLOAD_PATH, async (c) => {
    if (!(await deps.sessionActor(c.req.raw)))
      return c.json({ error: "Unauthorized" }, 401, notFound);

    const filePath = deps.filePath;
    if (!filePath) return c.json({ error: "Not found" }, 404, notFound);
    let size: number;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return c.json({ error: "Not found" }, 404, notFound);
      size = info.size;
    } catch {
      return c.json({ error: "Not found" }, 404, notFound);
    }

    // The build keeps the APK's own name, so browsers save what the operator published.
    const filename = (basename(filePath) || "app.apk").replace(/["\\\r\n]/g, "");
    const headers = {
      "content-type": "application/vnd.android.package-archive",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(
      Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>,
      { status: 200, headers },
    );
  });
}
