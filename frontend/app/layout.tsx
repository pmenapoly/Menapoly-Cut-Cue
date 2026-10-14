import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Menapoly Cut Cue",
  description: "Your private AI video editor: upload, ask Cue, approve, export.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0a12" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
