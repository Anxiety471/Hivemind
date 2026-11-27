/**
 * Text from a PDF, for previews in drive_read. The parser is loaded only when a PDF is actually
 * read, so runs that never open one do not pay for it at startup.
 */
import { bestEffort } from "@rakazo/logging";

export type PdfText = {
  text: string;
  pages: number;
};

/** The pdf.js error names that mean "this file is not readable as a PDF" rather than a server fault. */
const UNREADABLE_PDF_ERRORS = new Set(["InvalidPDFException", "PasswordException"]);

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText | null> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // pdf.js takes ownership of the buffer it is given and detaches it, so it gets a copy.
    document = await getDocumentProxy(bytes.slice());
    const { text, totalPages } = await extractText(document, { mergePages: true });
    return { text, pages: totalPages };
  } catch (error) {
    if (error instanceof Error && UNREADABLE_PDF_ERRORS.has(error.name)) return null;
    throw error;
  } finally {
    // The worker and document memory are held by the loading task, which unpdf itself destroys
    // when it opens a document; a failed destroy is logged rather than replacing the result.
    await bestEffort("extract-pdf-text.destroy", document?.loadingTask.destroy());
  }
}
