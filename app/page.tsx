import AppShell from "@/components/AppShell";
import Chat from "@/components/Chat";
import GraphPlaceholder from "@/components/GraphPlaceholder";

// GraphPlaceholder renders the #d3-graph-container + empty-state behind
// Chat; Chat currently occupies the same center-panel slot on top of it.
// A later task re-homes Chat into a search-bar overlay, at which point
// GraphPlaceholder is what actually fills the panel. Left/right panels
// render empty-but-classed until their own content (History diary / Topic
// Detail) is ported.
export default function Home() {
  return (
    <AppShell
      center={
        <>
          <GraphPlaceholder />
          <Chat />
        </>
      }
    />
  );
}
