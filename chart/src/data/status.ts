import type { TDataState, IDataStatus, TDataStatusReason } from "../types";

export function createStatus(state: TDataState = "idle", reason: TDataStatusReason = "ok"): IDataStatus {
    return {
        state,
        reason,
        sourceTimeMs: null,
        receivedAtMs: null,
        retryAtMs: null,
        version: null,
        detail: null
    };
}

// only notify when status actually changes
export function patchStatus(current: IDataStatus, patch: Partial<IDataStatus>): IDataStatus {
    const next = { ...current, ...patch };
    for (const key of Object.keys(next) as (keyof IDataStatus)[]) {
        if (next[key] !== current[key]) {
            return next;
        }
    }
    return current;
}

// snapshots arrive about every 10 minutes, allow a little longer before marking one stale
// a healthy connection does not make an old snapshot fresh
export const POSITIONS_STALE_MS = 15 * 60_000;
export const MARK_STALE_MS = 15_000;

// compare the date and height in IDs like 20261023_1194200000
// for other formats, treat a different ID as newer
export function isNewerSnapshotId(candidate: string, current: string | null) {
    if (current === null) {
        return true;
    }
    const a = parseSnapshotId(candidate);
    const b = parseSnapshotId(current);
    if (a && b) {
        return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    }
    return candidate !== current;
}

function parseSnapshotId(id: string): [number, number] | null {
    const match = /^(\d{8})_(\d+)$/.exec(id);
    if (!match) {
        return null;
    }
    return [Number(match[1]), Number(match[2])];
}
