import type { ReactNode } from "react";
import type { SessionRole } from "@/components/SessionProvider";

export type DevViewAccess = "any" | "admin";
export interface DevViewDef {
  id: string;
  label: string;
  href: string;
  access: DevViewAccess;
  /** "planned" tabs render as unclickable dashed silhouettes; no route yet. */
  status: "live" | "planned";
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

function tabIcon(children: ReactNode) {
  return function TabIcon() {
    return (
      <svg className="hbar-nav-icon-img" {...SVG_PROPS}>
        {children}
      </svg>
    );
  };
}

// Glyph paths copied from explorer app.py _build_dev_tabs (_ICONS). Traces and
// Overview have no Dash glyph; drawn here in the same 24x24 stroke style.
const ClustersIcon = tabIcon(
  <>
    <circle cx="6" cy="6" r="2" />
    <circle cx="18" cy="6" r="2" />
    <circle cx="12" cy="14" r="2" />
    <circle cx="6" cy="20" r="2" />
    <circle cx="18" cy="20" r="2" />
  </>,
);
const DqBotIcon = tabIcon(
  <>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
    <polyline points="9 12 11 14 15 10" />
  </>,
);
const PromptsIcon = tabIcon(
  <>
    <polygon points="12 2 21 7 21 17 12 22 3 17 3 7" />
    <line x1="12" y1="22" x2="12" y2="12" />
    <line x1="3" y1="7" x2="12" y2="12" />
    <line x1="21" y1="7" x2="12" y2="12" />
  </>,
);
const DataIcon = tabIcon(
  <>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
    <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
  </>,
);
const LogsIcon = tabIcon(
  <>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </>,
);
// Waterfall: three stacked bars, decreasing length, each offset further right.
const TracesIcon = tabIcon(
  <>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="7" y1="12" x2="18" y2="12" />
    <line x1="11" y1="18" x2="16" y2="18" />
  </>,
);
const OverviewIcon = tabIcon(
  <>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
    <rect x="13" y="13" width="8" height="8" rx="2" />
  </>,
);

// Tab order = array order (the recorded 05 information architecture).
// "planned" entries are placeholder silhouettes until their batch lands.
export const DEV_VIEWS: DevViewDef[] = [
  { id: "overview", label: "Overview", href: "/dev/overview", access: "any", status: "live", Icon: OverviewIcon },
  { id: "data", label: "Data", href: "/dev/data", access: "any", status: "planned", Icon: DataIcon },
  { id: "pipeline", label: "Pipeline", href: "/dev/pipeline", access: "any", status: "live", Icon: PipelineIcon },
  { id: "clusters", label: "Clusters", href: "/dev/clusters", access: "any", status: "live", Icon: ClustersIcon },
  { id: "dqbot", label: "dqBot", href: "/dev/dqbot", access: "admin", status: "planned", Icon: DqBotIcon },
  { id: "prompts", label: "Prompts", href: "/dev/prompts", access: "any", status: "live", Icon: PromptsIcon },
  { id: "logs", label: "Logs", href: "/dev/logs", access: "admin", status: "planned", Icon: LogsIcon },
  { id: "traces", label: "Traces", href: "/dev/traces", access: "admin", status: "planned", Icon: TracesIcon },
];

export function liveDevViews(): DevViewDef[] {
  return DEV_VIEWS.filter((v) => v.status === "live");
}

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
