import type { resolveComposerSendPlan } from "@rakazo/core";
import type { PendingDriveFile } from "../../pages/shell/chat/chat-shared";

/** How many attachment bytes the queue may hold on disk. */
export const OUTBOX_MAX_BYTES = 100 * 1024 * 1024;

/** A file waiting to be uploaded, kept as bytes so a reload still has it. */
export type StoredOutboxAttachment =
  | {
      kind: "file";
      id: string;
      name: string;
      mimeType: string;
      size: number;
      file: Blob;
      uploadNonce: string;
    }
  | { kind: "drive"; id: string; driveFile: PendingDriveFile };

/** Everything a queued send needs to go out again after a reload. */
export type StoredWebSendPayload = {
  originThreadKey: string;
  displayText: string;
  replyPreview: string | null;
  initialBotTarget?: string;
  botTarget?: string;
  groupTarget?: string;
  reroutedToGroup: boolean;
  plan: ReturnType<typeof resolveComposerSendPlan>;
  trimmed: string;
  replyToMessageId?: string;
  replyQuote?: string;
  fromPage?: true;
  attachments: StoredOutboxAttachment[];
};

/** A queued send as IndexedDB holds it: no live objects, only plain data and blobs. */
export type StoredWebSendAttempt = {
  clientNonce: string;
  createdAt: number;
  scope: { origin: string; userId: string; spaceId: string | null };
  state: "queued" | "failed" | "refused";
  payload: StoredWebSendPayload;
  artifactIds: Array<[string, string]>;
  error?: string;
  imageConfirmation?: boolean;
  imageHandling?: "file";
  retryCount: number;
};

export type OutboxScope = { origin: string; userId: string };

const DATABASE_NAME = "rakazo-send-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "attempts";

/** One open per page: reopening for every save would queue behind the previous close. */
let database: Promise<IDBDatabase | null> | undefined;

function openDatabase(): Promise<IDBDatabase | null> {
  database ??= new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) {
        resolve(null);
        return;
      }
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      // A browser can refuse storage outright (private mode, blocked site data).
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: "clientNonce" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgraded the schema: this connection must let go or block it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}

/** Resolves a request or rejects with the reason the browser gave. */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves once the transaction committed; a failure means nothing was written. */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function storedAttempts(record: unknown): record is StoredWebSendAttempt {
  const attempt = record as Partial<StoredWebSendAttempt> | null | undefined;
  return (
    typeof attempt?.clientNonce === "string" &&
    typeof attempt.scope?.origin === "string" &&
    typeof attempt.scope?.userId === "string" &&
    typeof attempt.payload === "object" &&
    attempt.payload !== null &&
    Array.isArray(attempt.payload.attachments)
  );
}

async function readAllAttempts(): Promise<StoredWebSendAttempt[]> {
  const db = await openDatabase();
  if (!db) return [];
  const transaction = db.transaction(STORE_NAME, "readonly");
  const [records] = await Promise.all([
    requestResult(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<StoredWebSendAttempt[]>,
    ),
    transactionDone(transaction),
  ]);
  return records.filter(storedAttempts);
}

function attemptBytes(attempt: StoredWebSendAttempt): number {
  let bytes = 0;
  for (const attachment of attempt.payload.attachments)
    if (attachment.kind === "file") bytes += attachment.file.size;
  return bytes;
}

/** This browser's queued sends for one account, oldest first. Never throws. */
export async function loadOutboxAttempts(scope: OutboxScope): Promise<StoredWebSendAttempt[]> {
  try {
    const stored = await readAllAttempts();
    return stored
      .filter(
        (attempt) => attempt.scope.origin === scope.origin && attempt.scope.userId === scope.userId,
      )
      .sort((left, right) => left.createdAt - right.createdAt);
  } catch {
    return [];
  }
}

/** Saves one queued send; false when it does not fit the byte budget or storage refused it. */
export async function putOutboxAttempt(record: StoredWebSendAttempt): Promise<boolean> {
  try {
    const db = await openDatabase();
    if (!db) return false;
    let storedBytes = 0;
    for (const attempt of await readAllAttempts()) {
      if (attempt.clientNonce === record.clientNonce) continue;
      storedBytes += attemptBytes(attempt);
    }
    if (storedBytes + attemptBytes(record) > OUTBOX_MAX_BYTES) return false;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
    return true;
  } catch {
    return false;
  }
}

export async function deleteOutboxAttempt(clientNonce: string): Promise<void> {
  try {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(clientNonce);
    await transactionDone(transaction);
  } catch {
    // The record left behind cannot deliver twice: the server keys the send by its nonce.
  }
}

/** Signing out leaves no unsent message or file for whoever uses this browser next. */
export async function clearOutboxStorage(): Promise<void> {
  try {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
  } catch {
    // Without storage there was nothing saved.
  }
}

/** Test-only: forget the open connection so a new IndexedDB implementation is picked up. */
export function resetOutboxStorageForTests(): void {
  database = undefined;
}
