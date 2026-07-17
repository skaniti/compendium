"use client";

import type { CSSProperties } from "react";
import { getSwatches, type Swatch } from "@/lib/theme";
import { useTheme } from "./ThemeProvider";
import { useStarfield } from "./StarfieldProvider";

// Mirrors app.py's _format_palette_caption: strips a legacy trailing
// " Dark" suffix (pre-2026-07-17 persisted value) so old and new palette
// names both render the same caption. None of the current 8 swatch names
// carry the suffix, but the strip is cheap insurance against a stale
// persisted value round-tripping through here.
export function formatPaletteCaption(name: string): string {
  const SUFFIX = " Dark";
  return name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : name;
}

const STARFIELD_VARIANTS = ["none", "twinkle", "pan", "hyperspace"] as const;

const PALETTE_GRID_STYLE: CSSProperties = {
  position: "absolute",
  right: "5px",
  top: "100%",
  borderRadius: "8px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  zIndex: 100,
  background: "var(--accent)",
  overflow: "hidden",
};

const TRIGGER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "2px",
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "var(--on-primary)",
  borderRadius: "8px",
  padding: "0",
  cursor: "pointer",
  fontFamily: "inherit",
  width: "76px",
  minWidth: "76px",
  height: "90px",
  boxSizing: "border-box",
};

const SWATCH_ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(8, 1fr)",
  gap: "6px",
  padding: "8px",
  background: "rgba(38,38,38,0.75)",
};

function swatchStyle(swatch: Swatch, size = 28): CSSProperties {
  return {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "22%",
    border: "none",
    background:
      `linear-gradient(to bottom, ${swatch.band_light} 33.33%, ${swatch.band_mid} 33.33%, ` +
      `${swatch.band_mid} 66.67%, ${swatch.band_dark} 66.67%) left / 60% 100% no-repeat, ` +
      `linear-gradient(${swatch.highlight}, ${swatch.highlight}) right / 40% 100% no-repeat`,
    cursor: "pointer",
    padding: "0",
    flexShrink: 0,
  };
}

export interface SettingsMenuProps {
  // Replay-tutorial behavior (window.__compendiumLoader.replay()) lands in
  // a later task alongside the loader port.
  onReplayTutorial?: () => void;
  // Opens the live scale / LOD / shape tuner panel (Dash: assets/
  // _dev_tuner.js attaches a click listener to #tuner-open-btn directly,
  // no callback). Panel port/disposition lands with the dev-tuner work.
  onOpenTuners?: () => void;
}

export default function SettingsMenu({
  // TODO(mig-01 task 9): wire to window.__compendiumLoader.replay().
  onReplayTutorial = () => {},
  // TODO(mig-03/05): tuner open behavior arrives with the dev-tuner port/disposition.
  onOpenTuners = () => {},
}: SettingsMenuProps) {
  const { variant, setVariant } = useTheme();
  // STARFIELD pills read/drive StarfieldProvider directly, same pattern as
  // the THEME swatches above -- no prop plumbing (mig-01 task 8; this used
  // to be a no-op `activeStarfield`/`onStarfieldChange` prop pair before
  // StarfieldProvider existed).
  const { variant: activeStarfield, setVariant: setStarfieldVariant } = useStarfield();
  const swatches = getSwatches();

  return (
    <div className="palette-picker" style={{ position: "relative", flexShrink: 0 }}>
      <div title="Settings" style={TRIGGER_STYLE}>
        <div className="hbar-nav-icon">
          {/* Gear icon: same feather/lucide path as app.py's _build_palette_picker,
              ported to a native <svg> instead of a base64 data-URI <img> -- Dash's
              html module has no raw svg element, JSX does. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="hbar-nav-icon-img"
            style={{ display: "block" }}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
            />
          </svg>
        </div>
        <span className="hbar-nav-caption">Settings</span>
      </div>

      <div className="palette-grid" style={PALETTE_GRID_STYLE}>
        {/* THEME */}
        <div className="picker-section-header">
          THEME: <span id="theme-active-name">{formatPaletteCaption(variant)}</span>
        </div>
        <div className="palette-rows-wrapper">
          <div className="palette-row palette-row-dark" style={SWATCH_ROW_STYLE}>
            {swatches.map((swatch) => (
              <button
                key={swatch.name}
                type="button"
                title={formatPaletteCaption(swatch.name)}
                className={`palette-swatch${swatch.name === variant ? " active" : ""}`}
                style={swatchStyle(swatch)}
                onClick={() => setVariant(swatch.name)}
              />
            ))}
          </div>
        </div>

        {/* STARFIELD */}
        <div className="picker-section-header">STARFIELD</div>
        <div className="starfield-pills-row">
          {STARFIELD_VARIANTS.map((v) => (
            <button
              key={v}
              type="button"
              data-variant={v}
              className={`starry-sky-selector-pill${v === activeStarfield ? " active" : ""}`}
              onClick={() => setStarfieldVariant(v)}
            >
              {v}
            </button>
          ))}
        </div>

        {/* TUTORIAL */}
        <div className="picker-section-header">TUTORIAL</div>
        <div className="tutorial-row">
          <button
            type="button"
            id="replay-tutorial-btn"
            className="palette-picker-action"
            onClick={() => onReplayTutorial()}
          >
            Replay tutorial
          </button>
        </div>

        {/* DISPLAY TUNERS */}
        <div className="picker-section-header">DISPLAY TUNERS</div>
        <div className="tutorial-row">
          <button
            type="button"
            id="tuner-open-btn"
            className="palette-picker-action"
            onClick={() => onOpenTuners()}
          >
            Open display tuners
          </button>
        </div>
      </div>
    </div>
  );
}
