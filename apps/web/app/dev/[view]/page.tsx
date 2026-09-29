import { notFound } from "next/navigation";
import AppShell from "@/components/AppShell";
import { findDevView, isPlainDemo } from "@/lib/dev-views";
import { getInitialSessionRole } from "@/lib/preferences.server";

export const dynamic = "force-dynamic";

export default async function DevViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  const def = findDevView(view);
  if (!def) notFound();
  const { role, actingAsDemo } = await getInitialSessionRole();
  if (def.access === "admin" && isPlainDemo(role, actingAsDemo)) notFound();
  const View = def.View;
  return (
    <AppShell mode="dev">
      <View />
    </AppShell>
  );
}
