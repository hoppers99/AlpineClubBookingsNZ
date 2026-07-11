import type { Metadata } from "next";
import { DisplayScreen } from "./display-screen";
import "./display.css";

// The lobby TV display page (fork issue #32, epic #25): a full-screen,
// read-only, non-interactive surface. Auth is the display-token cookie
// (ADR-001) — an unpaired browser sees only a pairing code. The lobbyDisplay
// module flag gates this whole route at the proxy (404 when off).

export const metadata: Metadata = {
  title: "Lobby display",
  robots: { index: false, follow: false },
};

export default function DisplayPage() {
  return <DisplayScreen />;
}
