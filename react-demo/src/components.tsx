import { useEffect, useRef, useState, type ReactNode } from "react";

// close the dropdown on an outside press or Escape
export function Dropdown(props: { label: string; active: boolean; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
                button.current?.focus();
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    return (
        <div className="dropdown" ref={root}>
            <button
                ref={button}
                className="btn"
                aria-expanded={open}
                data-off={props.active ? undefined : ""}
                onClick={() => setOpen((value) => !value)}
            >
                {props.label}
                <span className="dropdown-caret">▾</span>
            </button>
            {open && (
                <div className="dropdown-card" role="dialog" aria-label={`${props.label} options`}>
                    {props.children}
                </div>
            )}
        </div>
    );
}

export function Row(props: { label: string; title?: string; children: ReactNode }) {
    return (
        <div className="dropdown-row" title={props.title}>
            <span className="text-muted">{props.label}</span>
            <div className="dropdown-controls">{props.children}</div>
        </div>
    );
}

export function Toggle(props: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
    return (
        <label className="flex cursor-pointer select-none items-center gap-1.5">
            <input
                type="checkbox"
                checked={props.checked}
                onChange={(e) => props.onChange(e.target.checked)}
            />
            {props.label}
        </label>
    );
}

export function Segmented<T extends string | number>(props: {
    value: T;
    options: readonly T[];
    onChange: (value: T) => void;
    format?: (value: T) => string;
}) {
    return (
        <div className="segmented" role="group">
            {props.options.map((option) => (
                <button
                    key={String(option)}
                    aria-pressed={option === props.value}
                    onClick={() => props.onChange(option)}
                >
                    {props.format ? props.format(option) : String(option)}
                </button>
            ))}
        </div>
    );
}
