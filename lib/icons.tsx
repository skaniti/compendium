// Port of the Dash icon mechanism: frontend/dash/utils/icon_helpers.py +
// assets/icon_data.json (compendium-explorer, private repo). The JSON
// sidecar (lib/icon-data.json) is a verbatim copy -- icon path geometry
// only, public-safe, no edits. Task 8-C1 (batch: header-widget-cards
// foundations).
//
// Dash rendered icons as base64 data-URI <img> tags (icon_svg_data_uri /
// icon_img) because Dash has no inline-SVG-as-React-element story; that
// encoding step was pure Dash scaffolding, not part of the icon contract.
// TopicIcon below renders the equivalent inline <svg> directly instead.

import iconDataRaw from "./icon-data.json";

export interface IconEntry {
  label: string;
  category: string;
  viewBox: string;
  paths: string[];
}

interface IconDataFile {
  _category_order: string[];
  icons: Record<string, IconEntry>;
}

// Widen the JSON module's inferred literal types to plain string-indexed
// shapes, same idiom as lib/theme.ts's rawGoldens cast.
const iconData = iconDataRaw as IconDataFile;

// Pure port of icon_helpers.get_icons_grouped, parameterized on the
// (icons, categoryOrder) pair so it's testable against a small synthetic
// fixture -- the real sidecar has zero icons whose category falls outside
// _category_order, so the "Uncategorized" trailing-bucket branch has no
// real-data example to exercise it against.
export function groupIcons(
  icons: Record<string, IconEntry>,
  categoryOrder: string[]
): Array<[category: string, iconIds: string[]]> {
  const grouped: Record<string, string[]> = {};
  for (const category of categoryOrder) grouped[category] = [];

  for (const [iconId, meta] of Object.entries(icons)) {
    const category = meta.category ?? "Uncategorized";
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(iconId);
  }

  const result: Array<[string, string[]]> = [];
  for (const category of categoryOrder) {
    if (grouped[category].length > 0) {
      result.push([category, [...grouped[category]].sort()]);
    }
  }
  const orderSet = new Set(categoryOrder);
  for (const category of Object.keys(grouped)) {
    if (!orderSet.has(category) && grouped[category].length > 0) {
      result.push([category, [...grouped[category]].sort()]);
    }
  }
  return result;
}

export function getIconsGrouped(): Array<[category: string, iconIds: string[]]> {
  return groupIcons(iconData.icons, iconData._category_order);
}

export interface TopicIconProps {
  iconId: string;
  size: number;
  // An explicit color (e.g. "#facc15") or the literal "currentColor" to
  // inherit the surrounding text color -- the latter is the default so an
  // un-styled <TopicIcon> follows its container's color like normal text.
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  className?: string;
}

// Port of icon_svg_data_uri, rendered as a real inline <svg> element
// instead of a base64 data-URI. Unknown iconId -> null (Dash's equivalent,
// icon_img, returns an empty html.Span; a bare `null` is the React
// analogue of "render nothing").
export function TopicIcon({
  iconId,
  size,
  stroke = "currentColor",
  strokeWidth = 1.5,
  strokeDasharray,
  className,
}: TopicIconProps) {
  const icon = iconData.icons[iconId];
  if (!icon) return null;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={icon.viewBox}
      width={size}
      height={size}
      className={className}
    >
      {icon.paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={strokeDasharray}
        />
      ))}
    </svg>
  );
}
