/**
 * The picker offers every file; the composer rejects blocked executables, unsupported types and
 * oversized files in JavaScript, so broad formats like video, code and archives need no list.
 */
export function attachmentPickerAccept(): string {
  return "*/*";
}
