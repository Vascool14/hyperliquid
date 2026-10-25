export function formatUsd(value: number): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    if (abs >= 1e9) {
        return `${sign}$${trim(abs / 1e9)}B`;
    }
    if (abs >= 1e6) {
        return `${sign}$${trim(abs / 1e6)}M`;
    }
    if (abs >= 1e3) {
        return `${sign}$${trim(abs / 1e3)}K`;
    }
    if (abs === 0) {
        return "$0";
    }
    return `${sign}$${abs.toFixed(abs >= 100 ? 0 : 2)}`;
}

function trim(value: number): string {
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

// Hyperliquid perps use up to 5 significant figures for prices
export function priceDecimals(price: number): number {
    if (!(price > 0)) {
        return 2;
    }
    const integerDigits = Math.floor(Math.log10(price)) + 1;
    return Math.min(6, Math.max(0, 5 - integerDigits));
}

// use the reference price to choose decimal places, defaulting to the price itself
export function formatPrice(price: number, reference: number = price): string {
    return price.toLocaleString("en-US", {
        minimumFractionDigits: priceDecimals(reference),
        maximumFractionDigits: priceDecimals(reference)
    });
}

export function formatPriceRange(from: number, to: number): string {
    return `${formatPrice(from, to)} – ${formatPrice(to, to)}`;
}

export function formatSize(size: number): string {
    return Math.abs(size).toLocaleString("en-US", { maximumFractionDigits: 5 });
}

export function formatCount(count: number): string {
    return count.toLocaleString("en-US");
}

export function formatPercent(value: number): string {
    const sign = value > 0 ? "+" : "";
    return `${sign}${(value * 100).toFixed(2)}%`;
}

export function shortAddress(address: string): string {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatAge(ms: number | null, now: number): string {
    if (ms === null) {
        return "age unknown";
    }
    const seconds = Math.max(0, Math.round((now - ms) / 1000));
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    return `${(minutes / 60).toFixed(1)}h ago`;
}

export function formatIn(ms: number | null, now: number): string {
    if (ms === null) {
        return "";
    }
    const seconds = Math.max(0, Math.round((ms - now) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

export function formatClock(ms: number): string {
    return new Date(ms).toISOString().slice(11, 19);
}

// show the 2 largest units, like 1h 3m
export function formatDuration(ms: number): string {
    const seconds = Math.round(Math.max(0, ms) / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTime(ms: number | null): string {
    if (ms === null) {
        return "–";
    }
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
