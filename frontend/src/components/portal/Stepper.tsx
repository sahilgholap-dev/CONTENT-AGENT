"use client";

/** Wizard progress dots: done (✓) / active / upcoming. */
export default function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="mb-6 flex items-center gap-2 text-xs text-cs-muted">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          {i > 0 && <div className="h-px w-10 bg-cs-border" />}
          <div
            className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold ${
              i < current
                ? "border-cs-accent bg-cs-accent-soft text-cs-accent-deep"
                : i === current
                  ? "border-cs-accent bg-cs-accent text-white"
                  : "border-cs-border bg-cs-gray-soft text-cs-muted"
            }`}
          >
            {i < current ? "✓" : i + 1}
          </div>
          <span className="mx-1 font-medium">{label}</span>
        </div>
      ))}
    </div>
  );
}
