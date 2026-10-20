// Line icons (24×24, stroke = currentColor), drawn for this app. Decorative: always aria-hidden.
const P = {
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  sparkles: ["M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z", "M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  sliders: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M1 14h6", "M9 8h6", "M17 16h6"],
  back: ["M15 18l-6-6 6-6"],
  chevron: ["M9 18l6-6-6-6"],
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M17 8l-5-5-5 5", "M12 3v12"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  play: ["M7 4l13 8-13 8z"],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  film: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M7 3v18", "M17 3v18", "M3 8h4", "M3 16h4", "M17 8h4", "M17 16h4"],
  wave: ["M2 12h2", "M6 8v8", "M10 5v14", "M14 9v6", "M18 7v10", "M22 12h-2"],
  doc: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6", "M8 13h8", "M8 17h5"],
  laptop: ["M4 5h16v11H4z", "M2 19h20"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
  refresh: ["M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5"],
  plus: ["M12 5v14", "M5 12h14"],
  send: ["M22 2 11 13", "M22 2l-7 20-4-9-9-4z"],
  archive: ["M3 4h18v4H3z", "M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8", "M10 12h4"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
  offline: ["M2 2l20 20", "M8.5 16.5a5 5 0 0 1 7 0", "M12 20h.01", "M5 12.9a10 10 0 0 1 5.2-2.8", "M19 12.9a10 10 0 0 0-2.3-1.6", "M2 8.8a15 15 0 0 1 4.2-2.7", "M22 8.8A15 15 0 0 0 10.7 5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  logo: ["M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z", "M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"],
};

export function icon(name, size = 20) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");
  for (const d of P[name] || []) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
