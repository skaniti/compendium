import { notFound } from "next/navigation";
import type { ReactNode } from "react";

// Dev-only spike routes for the F2 graph-canvas bake-off (batch 03 plan,
// Task group S) -- see
// docs/project-plans/2026-07-07-220618-nextjs-mig-03-graph/plan.md. Gating
// here (the layout every route under app/sandbox/** shares) covers both
// current sandboxes AND any future one added to this tree, rather than
// repeating the check per page. The whole app/sandbox/ tree is deleted at
// promotion (Task S4), once the bake-off's winner is picked.
export default function SandboxLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return children;
}
