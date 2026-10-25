// keep the selected price range when zooming, resolve its records again when data changes

import type {
    ILiquidationSelection,
    IPositionsSnapshot,
    TSelection,
    TSelectionResolution,
    ITpslSelection,
    ITriggerOrderRecord
} from "../types";
import { ordersInRange, positionsInRange, PriceGrid, type TTpslFilter } from "./aggregate";

export interface ISelectionKey {
    layer: "liquidations" | "tpsl";
    coin: string;
    grid: PriceGrid;
    fromIndex: number;
    toIndex: number;
    // remember the snapshot ID or order signature so we can flag changes to the selection
    initialVersion: string | null;
}

function resolution(
    count: number,
    initialVersion: string | null,
    version: string | null
): TSelectionResolution {
    if (count === 0) {
        return "empty";
    }
    return initialVersion === version ? "current" : "updated";
}

export function resolveLiquidationSelection(
    key: ISelectionKey,
    snapshot: IPositionsSnapshot | null,
    minNotional: number
): ILiquidationSelection {
    const positions = snapshot
        ? positionsInRange(snapshot.positions, minNotional, key.grid, key.fromIndex, key.toIndex)
        : [];
    let longNotional = 0;
    let shortNotional = 0;
    for (const position of positions) {
        if (position.side === "long") {
            longNotional += position.notional;
        } else {
            shortNotional += position.notional;
        }
    }
    const version = snapshot?.snapshotId ?? null;

    return {
        layer: "liquidations",
        coin: key.coin,
        priceFrom: key.grid.lower(key.fromIndex),
        priceTo: key.grid.upper(key.toIndex),
        sourceVersion: version,
        resolution: resolution(positions.length, key.initialVersion, version),
        positions,
        longNotional,
        shortNotional
    };
}

export function resolveTpslSelection(
    key: ISelectionKey,
    orders: Iterable<ITriggerOrderRecord>,
    filter: TTpslFilter,
    height: number | null
): ITpslSelection {
    const matched = ordersInRange(orders, filter, key.grid, key.fromIndex, key.toIndex);
    const selection: ITpslSelection = {
        layer: "tpsl",
        coin: key.coin,
        priceFrom: key.grid.lower(key.fromIndex),
        priceTo: key.grid.upper(key.toIndex),
        sourceVersion: height === null ? null : String(height),
        resolution: "current",
        orders: matched,
        takeProfitCount: 0,
        stopLossCount: 0,
        unknownCount: 0,
        unknownSizeCount: 0,
        knownNotional: 0
    };

    for (const order of matched) {
        if (order.kind === "tp") {
            selection.takeProfitCount++;
        } else if (order.kind === "sl") {
            selection.stopLossCount++;
        } else {
            selection.unknownCount++;
        }
        if (order.sizeKnown) {
            selection.knownNotional += order.size * order.triggerPx!;
        } else {
            selection.unknownSizeCount++;
        }
    }
    selection.resolution = resolution(matched.length, key.initialVersion, orderSignature(matched));
    return selection;
}

// mark TP/SL selections updated when their member orders change
export function orderSignature(orders: readonly ITriggerOrderRecord[]): string {
    return orders
        .map((order) => order.id)
        .sort()
        .join(",");
}

export function isSameSelection(a: TSelection | null, b: TSelection | null) {
    if (a === null || b === null) {
        return a === b;
    }
    if (a.layer !== b.layer || a.resolution !== b.resolution) {
        return false;
    }
    if (a.priceFrom !== b.priceFrom || a.priceTo !== b.priceTo) {
        return false;
    }
    if (a.layer === "liquidations" && b.layer === "liquidations") {
        return a.sourceVersion === b.sourceVersion && a.positions.length === b.positions.length;
    }
    if (a.layer === "tpsl" && b.layer === "tpsl") {
        return (
            a.orders.length === b.orders.length &&
            a.orders.every((order, index) => order.id === b.orders[index]?.id)
        );
    }
    return false;
}
