import type { DiskCache } from "./cache.js";
import type { MirrorConfig } from "./config.js";
import type { PyPiFileIndex } from "./pypi-files.js";
import type { SingleFlight } from "./single-flight.js";
import type { UpstreamFetcher } from "./upstream.js";

/** Everything a protocol handler needs; built once per process. */
export interface MirrorContext {
  config: MirrorConfig;
  /** Hosts each ecosystem may fetch from, including that ecosystem's redirect targets. */
  hosts: {
    npm: ReadonlySet<string>;
    go: ReadonlySet<string>;
    pypi: ReadonlySet<string>;
    pypiFiles: ReadonlySet<string>;
    cratesIndex: ReadonlySet<string>;
    cratesDl: ReadonlySet<string>;
    composer: ReadonlySet<string>;
  };
  cache: DiskCache;
  fetcher: UpstreamFetcher;
  /** De-duplicates concurrent index and packument fetches. */
  documents: SingleFlight;
  /** De-duplicates concurrent artifact downloads. */
  artifacts: SingleFlight;
  pypiFiles: PyPiFileIndex;
  tempDir: string;
}
