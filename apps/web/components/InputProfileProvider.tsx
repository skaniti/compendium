"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { INPUT_PROFILES, type InputProfile, type WheelKind } from "@/lib/graph/wheel-intent";

// Context for the GRAPH CONTROLS setting: which input profile the graph's
// wheel mapping uses (`auto` | `mouse` | `trackpad`, vendor header comment
// delta #42). PER MACHINE on purpose (one owner, a laptop with a trackpad and
// a desktop with a mouse), so it lives in localStorage only, never in server
// preferences; same precedent as `compendium-theme`. It is read after mount,
// never during render, so the server HTML and the first client render agree
// (both `auto`); the stored value lands one effect later.
// Readers: SettingsMenu's GRAPH CONTROLS pills (useInputProfile, which also
// shows `detected`) and GraphCanvas (useOptionalInputProfile, since it also
// mounts without a provider in its own tests).

export const INPUT_PROFILE_STORAGE_KEY = "compendium-input-profile";

export interface InputProfileContextValue {
  profile: InputProfile;
  setProfile: (profile: InputProfile) => void;
  // What Auto last decided (null until a wheel gesture has been classified).
  detected: WheelKind | null;
  setDetected: (kind: WheelKind | null) => void;
}

const InputProfileContext = createContext<InputProfileContextValue | null>(null);

export function useInputProfile(): InputProfileContextValue {
  const ctx = useContext(InputProfileContext);
  if (!ctx) throw new Error("useInputProfile must be used within an InputProfileProvider");
  return ctx;
}

export function useOptionalInputProfile(): InputProfileContextValue | null {
  return useContext(InputProfileContext);
}

function isInputProfile(v: unknown): v is InputProfile {
  return typeof v === "string" && (INPUT_PROFILES as readonly string[]).includes(v);
}

function readStoredProfile(): InputProfile | null {
  try {
    const raw = localStorage.getItem(INPUT_PROFILE_STORAGE_KEY);
    return isInputProfile(raw) ? raw : null;
  } catch {
    // localStorage can throw (disabled, private mode); stay on auto.
    return null;
  }
}

function writeStoredProfile(profile: InputProfile): void {
  try {
    localStorage.setItem(INPUT_PROFILE_STORAGE_KEY, profile);
  } catch {
    // Non-fatal: the in-memory choice still applies for this tab.
  }
}

export default function InputProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<InputProfile>("auto");
  const [detected, setDetected] = useState<WheelKind | null>(null);

  useEffect(() => {
    const stored = readStoredProfile();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads an external store (localStorage) after mount so the first client render matches the server HTML
    if (stored) setProfileState(stored);
  }, []);

  const setProfile = useCallback((next: InputProfile) => {
    setProfileState(next);
    writeStoredProfile(next);
  }, []);

  const value = useMemo<InputProfileContextValue>(
    () => ({ profile, setProfile, detected, setDetected }),
    [profile, setProfile, detected]
  );

  return <InputProfileContext.Provider value={value}>{children}</InputProfileContext.Provider>;
}
