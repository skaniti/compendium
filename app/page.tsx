import AppShell from "@/components/AppShell";
import Chat from "@/components/Chat";

// Chat occupies the center panel for now; a later task re-homes it behind
// the graph canvas. Left/right panels render empty-but-classed until their
// own content (History diary / Topic Detail) is ported.
export default function Home() {
  return <AppShell center={<Chat />} />;
}
