/**
 * One Copilot session per thread across server instances.
 *
 * A turn holds a Blob lease on the thread's lease blob (same container as the
 * workspace, `{userKey}/{threadId}/lease`) for as long as it runs: acquired
 * before the session is opened, renewed while the turn runs, released at the
 * end. A second turn on the same thread (another tab, another instance) waits
 * briefly and then gets ThreadBusyError.
 *
 * The lease blob also records which instance ran the thread last. An instance
 * that still holds a live session for the thread but was NOT the last holder
 * must drop it and resume from Blob: another instance has appended to the
 * session state since.
 *
 * If a renewal fails, the lease may be taken by another instance; `onLost`
 * fires so the caller can stop the turn.
 */

/** The Blob lease operations the thread lease needs (Azure impl in azure-blob-store.ts). */
export interface LeaseBackend {
  /** Creates the empty lease blob when it does not exist (never overwrites). */
  ensureBlob(name: string): Promise<void>;
  /** Returns the lease id, or undefined when another holder has the lease. */
  acquire(name: string, durationSeconds: number): Promise<string | undefined>;
  renew(name: string, leaseId: string): Promise<void>;
  /** Writes metadata under the lease, then releases it. */
  release(name: string, leaseId: string, metadata: Record<string, string>): Promise<void>;
  readMetadata(name: string): Promise<Record<string, string>>;
}

export class ThreadBusyError extends Error {
  readonly status = 409;
  constructor() {
    super("A reply is still running in this chat. Wait for it to finish or stop it, then send again.");
    this.name = "ThreadBusyError";
  }
}

export interface ThreadLeaseOptions {
  /** Id of this server instance (process). */
  holder: string;
  /** Lease duration; Azure allows 15-60 s. */
  leaseSeconds?: number;
  renewEveryMs?: number;
  /** How long a second turn waits for the lease before ThreadBusyError. */
  waitMs?: number;
  pollMs?: number;
  onLost?: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ThreadLeaseHandle {
  /** Instance that held the thread last, or undefined for a new thread. */
  previousHolder: string | undefined;
  release(): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function acquireThreadLease(
  backend: LeaseBackend,
  name: string,
  options: ThreadLeaseOptions,
): Promise<ThreadLeaseHandle> {
  const leaseSeconds = options.leaseSeconds ?? 30;
  const renewEveryMs = options.renewEveryMs ?? 10_000;
  const waitMs = options.waitMs ?? 5_000;
  const pollMs = options.pollMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  await backend.ensureBlob(name);
  const deadline = Date.now() + waitMs;
  let leaseId = await backend.acquire(name, leaseSeconds);
  while (!leaseId) {
    if (Date.now() >= deadline) throw new ThreadBusyError();
    await sleep(pollMs);
    leaseId = await backend.acquire(name, leaseSeconds);
  }
  const id = leaseId;
  const previousHolder = (await backend.readMetadata(name)).holder || undefined;

  let released = false;
  let lost = false;
  const timer = setInterval(() => {
    if (released || lost) return;
    backend.renew(name, id).catch((err) => {
      lost = true;
      clearInterval(timer);
      options.onLost?.(err);
    });
  }, renewEveryMs);
  timer.unref?.();

  return {
    previousHolder,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (lost) return;
      await backend.release(name, id, { holder: options.holder });
    },
  };
}
