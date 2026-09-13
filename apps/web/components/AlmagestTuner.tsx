"use client";

import { useEffect, useState } from "react";
import Slider from "./tuner/Slider";
import {
  shippedParams,
  validateParams,
  paramsEqual,
  toJSON,
  fromJSON,
  PARAM_RANGES,
  TIER_NAMES,
  DRAFT_STORAGE_KEY,
  type AlmagestParams,
  type FrozenParams,
  type TierParams,
  type TierName,
} from "@/lib/almagest/params";

// Almagest graph tuner (dev-only). Mounted from GraphCanvas.tsx behind a
// `next/dynamic(..., { ssr: false })` guard gated on
// `process.env.NODE_ENV === "development"` (see that file's
// AlmagestTunerDev const) -- production bundles never execute this module,
// so it is free to import "@/lib/almagest/params", which side-effect-loads
// the CommonJS glyph generator. This component itself has no NODE_ENV
// awareness of its own; the mount site is the only gate.

const TIER_KEYS = Object.keys(PARAM_RANGES.tier) as Array<keyof TierParams>;
const FROZEN_KEYS = Object.keys(PARAM_RANGES.frozen) as Array<keyof FrozenParams>;

// "min" is the per-tier breakpoint (px) where that tier's face takes over --
// spelled out here since the raw field name means nothing to a designer.
const TIER_LABELS: Record<keyof TierParams, string> = {
  min: "breakpoint px",
  star: "star",
  contrast: "contrast",
  trim: "trim",
  stroke: "stroke",
  pointiness: "pointiness",
};

type PreviewFn = (params: AlmagestParams | null) => void;

function getPreviewFn(): PreviewFn | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __d3SetAlmagestPreview?: PreviewFn }).__d3SetAlmagestPreview;
}

function loadInitialParams(): AlmagestParams {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (raw) return fromJSON(raw);
    } catch {
      // corrupt/foreign draft -- fall through to shipped defaults
    }
  }
  return shippedParams();
}

// Keeps only the last few non-empty lines of a build log -- the panel's
// status line is one row, not a console.
function tailLines(text: string, n = 6): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n).join(" / ");
}

interface BakeSuccess { ok: true; version: string; log: string }
interface BakeFailure { error: string; log?: string }

export default function AlmagestTuner() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TierName>("Display");
  const [previewOn, setPreviewOn] = useState(false);
  const [params, setParams] = useState<AlmagestParams>(loadInitialParams);
  const [frozenOpen, setFrozenOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [baking, setBaking] = useState(false);

  const previewAvailable = typeof window !== "undefined" && typeof getPreviewFn() === "function";
  const isDirty = !paramsEqual(params, shippedParams());

  // Alt+A toggles open/closed regardless of focus location -- a global
  // listener on `document`, not scoped to the panel, so it works whether
  // or not the tuner currently has DOM focus. Matches on `e.code` ("KeyA",
  // the physical key) rather than `e.key` -- macOS's Option+A produces the
  // composed character "å" for `e.key`, not "a", so a `key`-based check
  // would silently never fire on that platform. Ignores the event when
  // focus is inside a form control or a contenteditable region, so typing
  // "a" with Alt held (e.g. an OS input-method chord) inside the panel's
  // own number inputs -- or any other text field in the app -- doesn't
  // also toggle the panel shut underneath the user.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.altKey || e.code !== "KeyA") return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      e.preventDefault();
      setOpen((o) => !o);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Every params change is persisted as the working draft, independent of
  // whether the panel is open or preview is on.
  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, toJSON(params));
    } catch {
      // best-effort draft persistence; a full/blocked localStorage must not
      // break the tuner
    }
  }, [params]);

  // Debounced live preview: while preview is on, push the current params
  // 50ms after the last change (coalescing fast slider drags into one
  // redraw). Deliberately does NOT push `null` here -- that transition is
  // owned by the effect below so it fires immediately, not debounced.
  useEffect(() => {
    if (!previewOn) return;
    const push = getPreviewFn();
    if (!push) return;
    const t = setTimeout(() => push(validateParams(params)), 50);
    return () => clearTimeout(t);
  }, [previewOn, params]);

  // Preview-off (including the initial mount, before the user has ever
  // turned it on) always pushes `null` immediately -- no debounce.
  useEffect(() => {
    if (previewOn) return;
    getPreviewFn()?.(null);
  }, [previewOn]);

  // Unconditional null push on unmount, so navigating away from the graph
  // never leaves a stale preview glyph rendered behind.
  useEffect(() => {
    return () => {
      getPreviewFn()?.(null);
    };
  }, []);

  function updateTier(key: keyof TierParams, value: number): void {
    setParams((prev) => ({ ...prev, tiers: { ...prev.tiers, [tab]: { ...prev.tiers[tab], [key]: value } } }));
  }

  function updateFrozen(key: keyof FrozenParams, value: number): void {
    setParams((prev) => ({ ...prev, frozen: { ...prev.frozen, [key]: value } }));
  }

  function handleReset(): void {
    setParams(shippedParams());
    setStatus("Reset to shipped defaults");
  }

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(toJSON(params));
      setStatus("Copied JSON to clipboard");
    } catch {
      setStatus("Copy failed -- clipboard unavailable");
    }
  }

  async function handleBake(): Promise<void> {
    setBaking(true);
    setStatus("Baking...");
    try {
      const res = await fetch("/api/dev/almagest/bake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: toJSON(params),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<BakeSuccess & BakeFailure>;
      if (res.ok && data.ok) {
        setStatus(`Baked ${data.version}; reloading`);
        window.location.reload();
      } else {
        const message = data.error ?? `bake failed (${res.status})`;
        setStatus(data.log ? `${message} -- ${tailLines(data.log)}` : message);
      }
    } catch (err) {
      setStatus(`Bake failed: ${(err as Error).message}`);
    } finally {
      setBaking(false);
    }
  }

  return (
    <>
      <button type="button" className="almagest-tuner-toggle" aria-label="Almagest tuner" onClick={() => setOpen((o) => !o)}>
        Aa
      </button>
      {open && (
        <div className="almagest-tuner" role="dialog" aria-label="Almagest tuner">
          <div className="tuner-title">Almagest tuner</div>
          <div className="tuner-tabs">
            {TIER_NAMES.map((t) => (
              <button key={t} type="button" className="tuner-tab" aria-pressed={tab === t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="tuner-sliders">
            {TIER_KEYS.map((key) => (
              <Slider
                key={key}
                id={`tuner-${tab}-${key}`}
                label={TIER_LABELS[key]}
                value={params.tiers[tab][key]}
                range={PARAM_RANGES.tier[key]}
                disabled={key === "min" && tab === "Text"}
                onChange={(v) => updateTier(key, v)}
              />
            ))}
          </div>
          <details className="tuner-frozen" open={frozenOpen} onToggle={(e) => setFrozenOpen(e.currentTarget.open)}>
            <summary>Advance-affecting (all tiers)</summary>
            <p className="tuner-warning">Changes advance widths for every tier; a tier swap may reflow a name.</p>
            {FROZEN_KEYS.map((key) => (
              <Slider
                key={key}
                id={`tuner-frozen-${key}`}
                label={key}
                value={params.frozen[key]}
                range={PARAM_RANGES.frozen[key]}
                onChange={(v) => updateFrozen(key, v)}
              />
            ))}
          </details>
          <div className="tuner-actions">
            <button
              type="button"
              role="switch"
              aria-checked={previewOn}
              className="tuner-switch"
              disabled={!previewAvailable}
              onClick={() => setPreviewOn((v) => !v)}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={handleReset}
              title={isDirty ? "Discard changes and restore shipped defaults" : "Already at shipped defaults"}
            >
              Reset to shipped
            </button>
            <button type="button" onClick={() => void handleCopy()}>
              Copy JSON
            </button>
            <button type="button" disabled={baking} onClick={() => void handleBake()}>
              Bake
            </button>
          </div>
          <p className="tuner-status" role="status">
            {status || (!previewAvailable ? "graph not ready" : "")}
          </p>
        </div>
      )}
    </>
  );
}
