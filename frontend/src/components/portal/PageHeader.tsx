"use client";

/** Sticky per-page topbar: title + subtitle on the left, actions on the
 *  right (mockup's .topbar). */
export default function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-cs-border bg-white px-8 py-3.5">
      <div>
        <div className="text-lg font-semibold tracking-[-0.3px]">{title}</div>
        {subtitle && <div className="mt-0.5 text-[13px] text-cs-muted">{subtitle}</div>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
