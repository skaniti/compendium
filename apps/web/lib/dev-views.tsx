import type { ReactNode } from "react";
import type { SessionRole } from "@/components/SessionProvider";

export type DevViewAccess = "any" | "admin";
export interface DevViewDef {
  id: string;
  label: string;
  href: string;
  access: DevViewAccess;
  Icon: () => ReactNode;
}

// Glyph markup ported from explorer frontend/dash/app.py (_build_dev_menu /
// _build_dev_tabs): 24x24 viewBox, white 1.8 stroke on the accent bar.
const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "white",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function PipelineIcon() {
  return (
    <svg className="hbar-nav-icon-img" {...SVG_PROPS}>
      <rect x="2" y="3" width="6" height="6" rx="1" />
      <rect x="16" y="3" width="6" height="6" rx="1" />
      <rect x="9" y="15" width="6" height="6" rx="1" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="5" y1="9" x2="11" y2="15" />
      <line x1="19" y1="9" x2="13" y2="15" />
    </svg>
  );
}

// Dev toggle glyph: </>
export function DevArrowsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...SVG_PROPS}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

// Graph toggle glyph: three nodes + edges
export function GraphGlyphIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...SVG_PROPS}>
      <circle cx="5" cy="19" r="2.2" />
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="19" cy="19" r="2.2" />
      <line x1="7" y1="18" x2="17" y2="18" />
      <line x1="6.5" y1="17" x2="11" y2="8" />
      <line x1="17.5" y1="17" x2="13" y2="8" />
    </svg>
  );
}

// Tab order = array order. Later sub-batches append (Data, Prompts, dqBot,
// Logs (admin), Clusters, Traces (admin), Overview).
export const DEV_VIEWS: DevViewDef[] = [
  { id: "pipeline", label: "Pipeline", href: "/dev/pipeline", access: "any", Icon: PipelineIcon },
];

export function findDevView(id: string): DevViewDef | undefined {
  return DEV_VIEWS.find((v) => v.id === id);
}
export function isPlainDemo(role: SessionRole | null, actingAsDemo: boolean): boolean {
  return role === "demo" && !actingAsDemo;
}
// ONE predicate for both the tab bar and the route gate: admin-only views are
// visible to an admin or an admin acting as demo; null/user/plain demo never.
export function canSeeAdminViews(role: SessionRole | null, actingAsDemo: boolean): boolean {
  return role === "admin" || actingAsDemo;
}
export function visibleDevViews(
  role: SessionRole | null,
  actingAsDemo: boolean,
  views: DevViewDef[] = DEV_VIEWS,
): DevViewDef[] {
  const adminish = canSeeAdminViews(role, actingAsDemo);
  return views.filter((v) => v.access === "any" || adminish);
}
