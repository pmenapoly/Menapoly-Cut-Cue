import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Menapoly Cue",
  description: "Your private video production app: projects, AI editing with Cut Cue, client reviews and delivery.",
};

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#11121B" }, { media: "(prefers-color-scheme: light)", color: "#F6F5FB" }],
};

// Apply the saved theme before first paint (no flash). Reads only localStorage; no network.
const THEME_SCRIPT = `try{var t=localStorage.getItem("cue-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body className="min-h-dvh antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
