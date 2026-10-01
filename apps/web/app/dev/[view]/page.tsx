import { notFound } from "next/navigation";
import AppShell from "@/components/AppShell";
import { canSeeAdminViews, findDevView } from "@/lib/dev-views";
import { getInitialSessionRole } from "@/lib/preferences.server";
import { DEV_VIEW_COMPONENTS } from "./views";

export const dynamic = "force-dynamic";

export default async function DevViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  const def = findDevView(view);
  if (!def || def.status !== "live") notFound();
  const { role, actingAsDemo } = await getInitialSessionRole();
  if (def.access === "admin" && !canSeeAdminViews(role, actingAsDemo)) notFound();
  const View = DEV_VIEW_COMPONENTS[def.id];
  if (!View) notFound();
  return (
    <AppShell mode="dev">
      <View />
    </AppShell>
  );
}
