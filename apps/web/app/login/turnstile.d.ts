// Minimal surface of Cloudflare Turnstile's explicit-render API used by
// DemoEntryForm (demo-one-click-entry).
interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  appearance?: "always" | "execute" | "interaction-only";
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

interface Window {
  turnstile?: TurnstileApi;
  onTurnstileLoad?: () => void;
}
