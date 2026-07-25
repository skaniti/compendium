import TopicDetail from "./TopicDetail";

// Ports the right panel's header band from app.py's graph-view layout
// (:1977-2005). The band is the "Topic Detail" label only (no controls,
// unlike HistoryPanel's granularity row); the content below it is the real
// render_topic_detail output (Task 7's TopicDetail.tsx -- PageView /
// ClusterView / WindowSummaryView, dispatching on useNav() state exactly
// like frontend/dash/layouts/topic_detail.py:70-125).
//
// This panel stays a server component (no "use client"): TopicDetail is the
// client island that actually calls useNav()/useGraph(), same composition
// shape as HistoryPanel -> DiaryPanel (task 6) even though HistoryPanel
// itself happens to be "use client" for its own local granularity state --
// the point ported here is "the panel owns the band, the inner component
// owns the hooks," not the server/client split itself.
//
// One Dash sibling remains deliberately NOT ported here (batch
// mig-02/explorer-owned per the "Header widget cards" row, surface-ledger.md):
//   - #sc-debug-console (app.py:1986-1990, DEBUG_SC=1 only)
//   - #suggested-topics-panel (app.py:1994-1998, hybrid supercluster mode)
// TODO(mig-02/batch-03): #sc-debug-console and #suggested-topics-panel land
// alongside the D3 graph / supercluster work.
export default function TopicDetailPanel() {
  return (
    <>
      <div className="panel-header-band">
        <p className="panel-header">Topic Detail</p>
      </div>
      {/* #detail-container (app.py:1999-2002) wraps whatever
          render_topic_detail returns. */}
      <div id="detail-container">
        <TopicDetail />
      </div>
    </>
  );
}
