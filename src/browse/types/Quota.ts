/**
 * A daily allowance.
 *
 * `null` means no limit, and is deliberately not the same as `0`: zero is a
 * reachable setting that means "nothing today", and folding the two together
 * would turn the strictest configuration into the loosest one.
 */
export interface UserQuota {
  /** Post pages that may be opened in a day. */
  posts: number | null;
  /** Videos that may be played in a day. */
  videos: number | null;
}

export type QuotaKind = keyof UserQuota;

/**
 * What a newly created ordinary account starts with.
 *
 * Accounts that already existed when limits were introduced keep
 * `UNLIMITED_QUOTA` instead - see `AuthStore.load`. Tightening an account that
 * someone is already using is an administrator's decision, not a migration's.
 */
export const DEFAULT_USER_QUOTA: UserQuota = { posts: 40, videos: 10 };

/** What administrators always carry, and what existing accounts kept. */
export const UNLIMITED_QUOTA: UserQuota = { posts: null, videos: null };

export interface QuotaCounter {
  limit: number | null;
  used: number;
  /** `null` when there is no limit. */
  remaining: number | null;
}

/**
 * Where an account stands today, as the browser is told it.
 *
 * The counters are the *distinct* posts and videos opened since the last
 * reset - going back to something already counted costs nothing, which is
 * what makes re-reading a post a free action rather than a penalty.
 */
export interface QuotaStatus {
  /** False for administrators and for anyone with both limits lifted. */
  limited: boolean;
  posts: QuotaCounter;
  videos: QuotaCounter;
  /** When the counters next go back to zero, as an ISO timestamp. */
  resetsAt: string;
}

/** The code a refusal carries, so the browser can tell it from a real 403. */
export const QUOTA_EXCEEDED_CODE = 'quota_exceeded';
