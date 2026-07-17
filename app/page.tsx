import AppShell from "@/components/AppShell";
import Chat from "@/components/Chat";
import GraphPlaceholder from "@/components/GraphPlaceholder";
import Starfield from "@/components/Starfield";

// GraphPlaceholder renders the #d3-graph-container + empty-state behind
// Chat; Chat currently occupies the same center-panel slot on top of it.
// A later task re-homes Chat into a search-bar overlay, at which point
// GraphPlaceholder is what actually fills the panel. Left/right panels
// render empty-but-classed until their own content (History diary / Topic
// Detail) is ported.
//
// Starfield renders first, matching Dash's sibling order in
// render_graph_canvas() (starry-sky-mount, then #d3-graph-container) --
// the ported CSS's explicit z-index (starry-sky: 0, d3-graph-container: 1)
// is what actually pins the stacking, not DOM order, but mirroring the
// source order keeps this consistent with it regardless.
export default function Home() {
  return (
    <AppShell
      center={
        <>
          <Starfield />
          <GraphPlaceholder />
          <Chat />
        </>
      }
    />
  );
}
