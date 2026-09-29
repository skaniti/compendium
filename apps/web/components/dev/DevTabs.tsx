"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/components/SessionProvider";
import { visibleDevViews } from "@/lib/dev-views";

export default function DevTabs() {
  const { role, actingAsDemo } = useSession();
  const pathname = usePathname();
  const views = visibleDevViews(role, actingAsDemo);
  return (
    <nav id="header-dev-tabs" className="hbar-dev-tabs" aria-label="Dev views">
      {views.map((v) => (
        <Link key={v.id} href={v.href} className={`dev-tab-btn${pathname === v.href ? " active" : ""}`}>
          <span className="hbar-nav-icon"><v.Icon /></span>
          <span className="hbar-nav-caption">{v.label}</span>
        </Link>
      ))}
    </nav>
  );
}
