import type { ComponentType } from "react";
import PipelineView from "@/components/dev/pipeline/PipelineView";

// Server-side view map, imported ONLY by page.tsx so the header/tab bar
// (client) never bundles view code. Keys match lib/dev-views.ts ids.
export const DEV_VIEW_COMPONENTS: Record<string, ComponentType> = {
  pipeline: PipelineView,
};
