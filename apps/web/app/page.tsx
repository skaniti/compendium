import AppShell from "@/components/AppShell";
import GraphCanvas from "@/components/GraphCanvas";
import HistoryPanel from "@/components/HistoryPanel";
import SearchBar from "@/components/SearchBar";
import Starfield from "@/components/Starfield";
import TopicDetailPanel from "@/components/TopicDetailPanel";

// Task 10: chat re-homed into the search-bar overlay. GraphCanvas (Task
// A1-1, promoted from the F2 sandbox bake-off's winning components/sandbox/
// GraphA1.tsx, replacing the deleted components/GraphPlaceholder.tsx) now
// fills the panel (it's the sole flex child of .panel-center's content
// slot -- see that component's own comment for why that matters); SearchBar
// renders .search-bar-wrapper, which is position:absolute (search-bar.css)
// and so sits OVER the graph rather than sharing flex space with it,
// matching graph_canvas.py's render_graph_canvas() layering (search bar is
// the last child appended, absolutely positioned at the bottom of
// .panel-center, not a flex sibling competing for height).
//
// Left/right slots now carry their header-band chrome (HistoryPanel,
// TopicDetailPanel -- mig-01 batch-01 acceptance-gate fix) mirroring
// app.py's .panel-left/.panel-right (:1926-2005). The actual panel
// CONTENT below each band -- the session diary, the real topic-detail
// views -- stays mig-02/explorer-owned (surface-ledger.md) until that
// batch lands; see each component's own comment for the exact TODO.
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
      left={<HistoryPanel />}
      center={
        <>
          <Starfield />
          <GraphCanvas />
          <SearchBar />
        </>
      }
      right={<TopicDetailPanel />}
    />
  );
}
