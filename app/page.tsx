import AppShell from "@/components/AppShell";
import GraphPlaceholder from "@/components/GraphPlaceholder";
import SearchBar from "@/components/SearchBar";
import Starfield from "@/components/Starfield";

// Task 10: chat re-homed into the search-bar overlay. GraphPlaceholder now
// fills the panel (it's the sole flex child of .panel-center's content
// slot -- see its own comment for why that matters); SearchBar renders
// .search-bar-wrapper, which is position:absolute (search-bar.css) and so
// sits OVER the graph rather than sharing flex space with it, matching
// graph_canvas.py's render_graph_canvas() layering (search bar is the last
// child appended, absolutely positioned at the bottom of .panel-center, not
// a flex sibling competing for height). Left/right panels render
// empty-but-classed until their own content (History diary / Topic Detail)
// is ported.
//
// Starfield renders first, matching Dash's sibling order in
// render_graph_canvas() (starry-sky-mount, then #d3-graph-container) --
// the ported CSS's explicit z-index (starry-sky: 0, d3-graph-container: 1)
// is what actually pins the stacking, not DOM order, but mirroring the
// source order keeps this consistent with it regardless. SearchBar renders
// last for the same reason (search-bar-wrapper's own z-index: 4 is what
// actually pins it above the graph/starfield/empty-state).
export default function Home() {
  return (
    <AppShell
      center={
        <>
          <Starfield />
          <GraphPlaceholder />
          <SearchBar />
        </>
      }
    />
  );
}
