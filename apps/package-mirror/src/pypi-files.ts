/** A file published by a project's simple index, keyed by its content hash. */
export interface PyPiFile {
  /** The upstream URL, with its `#sha256=` fragment, fetched only after the hash matches. */
  url: string;
  filename: string;
  sha256: string;
}

/**
 * Remembers where a file hash was published. A file request carries only the hash and name, so
 * this is how the mirror finds the upstream URL without trusting anything the client sent.
 */
export class PyPiFileIndex {
  private readonly byProject = new Map<string, PyPiFile[]>();
  private readonly byHash = new Map<string, PyPiFile>();

  set(project: string, files: PyPiFile[]): void {
    for (const file of this.byProject.get(project) ?? []) this.byHash.delete(file.sha256);
    this.byProject.set(project, files);
    for (const file of files) this.byHash.set(file.sha256, file);
  }

  get(hash: string): PyPiFile | undefined {
    return this.byHash.get(hash);
  }
}
