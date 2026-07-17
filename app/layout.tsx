import type { ReactNode } from "react";

import "./styles/theme.css";
import "./styles/style.css";
import "./styles/search-bar.css";
import "./styles/login.css";
import "./styles/starry-selector.css";
import "./styles/compendium-loader.css";

export const metadata = { title: "Compendium" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
