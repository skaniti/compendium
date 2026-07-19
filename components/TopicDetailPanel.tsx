// Ports the right panel's header band plus the nothing-selected empty state
// from app.py's graph-view layout (:1977-2005). The band is the "Topic
// Detail" label only (no controls, unlike HistoryPanel's granularity row);
// the content below it mirrors render_topic_detail's no-selection branch
// (frontend/dash/layouts/topic_detail.py:96-105), which is what
// #detail-container (app.py:1999-2002) holds before any node is clicked.
//
// Two Dash siblings are deliberately NOT ported here (both batch
// mig-02/explorer-owned per the Topic detail row, surface-ledger.md):
//   - #sc-debug-console (app.py:1986-1990, DEBUG_SC=1 only)
//   - #suggested-topics-panel (app.py:1994-1998, hybrid supercluster mode)
// TODO(mig-02): the real render_topic_detail output (breadcrumbs, node/
// cluster/window views) replaces the placeholder below once selection state
// exists; #sc-debug-console and #suggested-topics-panel land alongside it.
export default function TopicDetailPanel() {
  return (
    <>
      <div className="panel-header-band">
        <p className="panel-header">Topic Detail</p>
      </div>
      {/* #detail-container (app.py:1999-2002) wraps whatever
          render_topic_detail returns; topic_detail.py:99-105 is the
          nothing-selected branch rendered here -- a .panel-scroll holding a
          single .placeholder-text paragraph. */}
      <div id="detail-container">
        <div className="panel-scroll">
          <p className="placeholder-text">Click a node in the graph to see details.</p>
        </div>
      </div>
    </>
  );
}
