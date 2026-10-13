/** Dev: proxy /api to FastAPI on :8000. Build: static export served by FastAPI (make start). */
const isDev = process.env.NODE_ENV === "development";
const api = process.env.CUTCUE_API_URL || "http://127.0.0.1:8000";

/** @type {import('next').NextConfig} */
const config = isDev
  ? { async rewrites() { return [{ source: "/api/:path*", destination: `${api}/api/:path*` }]; } }
  : { output: "export", trailingSlash: true, images: { unoptimized: true } };

export default config;
