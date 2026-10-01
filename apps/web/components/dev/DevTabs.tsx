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
      {views.map((v) =>
        v.status === "live" ? (
          <Link key={v.id} href={v.href} className={`dev-tab-btn${pathname === v.href ? " active" : ""}`}>
            <span className="hbar-nav-icon"><v.Icon /></span>
            <span className="hbar-nav-caption">{v.label}</span>
          </Link>
        ) : (
          <span
            key={v.id}
            className="dev-tab-btn dev-tab-planned"
            aria-disabled="true"
            title={`${v.label} \u2014 coming in a later batch`}
          >
            <span className="hbar-nav-icon"><v.Icon /></span>
            <span className="hbar-nav-caption">{v.label}</span>
          </span>
        ),
      )}
    </nav>
  );
}
