// inject scoped styles once per document when a chart is created, never on import

const STYLE_ID = "hlc-styles";

const CSS = `
.hlc-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--hlc-bg);color:var(--hlc-text);font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}
.hlc-status{display:flex;align-items:center;gap:0.25rem;min-height:26px;padding:11px;border-bottom:1px solid var(--hlc-border);overflow-x:auto;white-space:nowrap;scrollbar-width:none}
.hlc-status::-webkit-scrollbar{display:none}
.hlc-chip{display:inline-flex;align-items:center;gap:5px;color:var(--hlc-muted)}
.hlc-chip b{font-weight:500;color:var(--hlc-text)}
.hlc-dot{width:6px;height:6px;border-radius:50%;background:var(--hlc-muted);flex:none}
.hlc-dot[data-tone=ok]{background:var(--hlc-ok)}
.hlc-dot[data-tone=warn]{background:var(--hlc-warn)}
.hlc-dot[data-tone=bad]{background:var(--hlc-bad)}
.hlc-spacer{flex:1}
.hlc-legend{display:inline-flex;align-items:center;gap:8px;color:var(--hlc-muted)}
.hlc-swatch{display:inline-block;width:8px;height:8px;margin-right:3px;margin-bottom:0.25px}
.hlc-ramp{display:inline-flex;gap:1px;margin-left:2px;vertical-align:-1px}
.hlc-ramp i{display:inline-block;width:6px;height:8px}
.hlc-btn{font:inherit;color:var(--hlc-text);background:transparent;border:1px solid var(--hlc-border);border-radius:2px;padding:1px 7px;cursor:pointer}
.hlc-btn:hover{border-color:var(--hlc-muted)}
.hlc-btn:focus-visible,.hlc-level:focus-visible,.hlc-card summary:focus-visible{outline:1px solid var(--hlc-accent);outline-offset:1px}
.hlc-chart{position:relative;flex:1;min-height:0}
.hlc-tooltip{position:absolute;z-index:3;pointer-events:none;min-width:200px;max-width:280px;padding:7px 9px;background:var(--hlc-surface);border:1px solid var(--hlc-border);border-radius:2px;box-shadow:var(--hlc-shadow)}
.hlc-tooltip[hidden],.hlc-card[hidden],.hlc-levels[hidden]{display:none}
.hlc-title{font-weight:600;margin-bottom:3px}
.hlc-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:3px}
.hlc-head .hlc-title{margin-bottom:0}
.hlc-share{margin:4px 0 6px}
.hlc-share-bar{display:flex;gap:1px;height:8px;border-radius:1px;overflow:hidden;background:var(--hlc-border)}
.hlc-share-key{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:4px;font-size:11px;color:var(--hlc-muted);font-variant-numeric:tabular-nums}
.hlc-sub{color:var(--hlc-muted)}
.hlc-kv{display:flex;justify-content:space-between;gap:12px}
.hlc-kv span:first-child{color:var(--hlc-muted)}
.hlc-kv span:last-child{font-variant-numeric:tabular-nums;text-align:right}
.hlc-note{margin-top:5px;color:var(--hlc-muted);font-size:11px}
.hlc-card{position:absolute;z-index:4;top:8px;width:320px;max-height:calc(100% - 16px);display:flex;flex-direction:column;background:var(--hlc-surface);border:1px solid var(--hlc-border);border-radius:2px;box-shadow:var(--hlc-shadow)}
.hlc-card-head{display:flex;align-items:flex-start;gap:8px;padding:8px;border-bottom:1px solid var(--hlc-border)}
.hlc-card-head>div{flex:1;min-width:0}
.hlc-card-body{padding:8px 10px;overflow:auto}
.hlc-badge{display:inline-block;padding:0 5px;margin-left:6px;border:1px solid var(--hlc-border);border-radius:2px;font-size:10px;letter-spacing:.04em;color:var(--hlc-muted)}
.hlc-badge[data-tone=warn]{color:var(--hlc-warn);border-color:var(--hlc-warn)}
.hlc-section{margin-top:10px;padding-top:8px;border-top:1px solid var(--hlc-border)}
.hlc-section-title{font-size:10px;letter-spacing:.06em;color:var(--hlc-muted);margin-bottom:4px}
.hlc-card details{border-bottom:1px solid var(--hlc-border)}
.hlc-card summary{display:flex;gap:8px;align-items:center;padding:4px 0;cursor:pointer;list-style:none;font-variant-numeric:tabular-nums}
.hlc-card summary::-webkit-details-marker{display:none}
.hlc-card summary .hlc-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.hlc-card details>div{padding:2px 0 6px 12px}
.hlc-side{font-size:10px;font-weight:600;text-transform:uppercase}
.hlc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.hlc-card a{color:inherit}
.hlc-levels{position:absolute;z-index:4;top:8px;left:8px;width:260px;max-height:calc(100% - 16px);overflow:auto;background:var(--hlc-surface);border:1px solid var(--hlc-border);border-radius:2px;box-shadow:var(--hlc-shadow);padding:6px}
.hlc-levels-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}
.hlc-levels-head .hlc-section-title{margin-bottom:0}
.hlc-divider{height:1px;margin:6px 0;background:var(--hlc-border)}
.hlc-level{display:flex;width:100%;justify-content:space-between;gap:8px;font:inherit;color:inherit;background:transparent;border:0;border-bottom:1px solid var(--hlc-border);padding:3px 2px;text-align:left;cursor:pointer;font-variant-numeric:tabular-nums}
.hlc-level:hover{background:var(--hlc-bg)}
.hlc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.hlc-root[data-narrow] .hlc-card{left:8px!important;right:8px!important;width:auto;top:auto;bottom:8px;max-height:60%}
.hlc-root[data-narrow] .hlc-legend{display:none}
`;

export function ensureStyles(doc: Document): void {
    // replace an old stylesheet after hot reload
    const existing = doc.getElementById(STYLE_ID);
    if (existing) {
        if (existing.textContent !== CSS) {
            existing.textContent = CSS;
        }
        return;
    }
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
}
