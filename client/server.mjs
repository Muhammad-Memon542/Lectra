// /Users/muhammadmemon/Desktop/md/server.mjs
// Zero-dependency static server + /api/files that lists your notes folder.

import { createServer } from "http";
import { readFile, stat, readdir } from "fs/promises";
import { existsSync, createReadStream } from "fs";
import path, { extname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ✅ Your notes folder (absolute path). Change if needed.
const NOTES_DIR = "./public/downloads";
// Root folder where index.html lives (same folder as this server file)
const ROOT = __dirname;
const PORT = process.env.PORT || 5500;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".pdf":  "application/pdf",
  ".md":   "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".mdown": "text/markdown; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".ico":  "image/x-icon"
};

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length
  });
  res.end(body);
}

function safeJoin(base, p) {
  const out = path.normalize(path.join(base, p));
  if (!out.startsWith(base)) throw new Error("Path traversal");
  return out;
}

async function listNotes() {
  const allowed = new Set([".pdf", ".md", ".markdown", ".mdown", ".txt"]);
  const entries = await readdir(NOTES_DIR, { withFileTypes: true });
  return entries
    .filter(d => d.isFile() && allowed.has(extname(d.name).toLowerCase()))
    .map(d => {
      const ext  = extname(d.name).toLowerCase();
      const type = ext === ".pdf" ? "pdf" : "md";
      const base = d.name.replace(/\.[^/.]+$/, "");
      const kind = type === "pdf" ? "PDF" : "MD";
      return { label: `${base} (${kind})`, file: d.name, type };
    })
    .sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // --- API: live list of notes
    if (url.pathname === "/api/files") {
      if (!existsSync(NOTES_DIR)) {
        console.error("NOTES_DIR not found:", NOTES_DIR);
        return sendJSON(res, 500, { error: `NOTES_DIR not found: ${NOTES_DIR}` });
      }
      const files = await listNotes();
      console.log(`[api] /api/files -> ${files.length} entries from ${NOTES_DIR}`);
      return sendJSON(res, 200, { files });
    }

    // --- Serve ./* directly from NOTES_DIR (outside ROOT is fine)
    if (url.pathname.startsWith("../")) {
      const rel = url.pathname.slice("../".length);
      const filePath = safeJoin(NOTES_DIR + path.sep, rel);
      if (!existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return; }
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      createReadStream(filePath).pipe(res);
      return;
    }

    // --- Static site from ROOT (index.html, quiz.html, etc.)
    let urlPath = decodeURIComponent(url.pathname);
    if (urlPath === "/") urlPath = "/index.html";
    if (urlPath.endsWith("/")) urlPath += "index.html";

    const filePath = safeJoin(ROOT + path.sep, "." + urlPath);
    const st = await stat(filePath);
    if (st.isDirectory()) {
      res.writeHead(301, { Location: urlPath + "/" });
      return res.end();
    }
    const ext = extname(filePath).toLowerCase();
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(body);

  } catch (e) {
    if (e.code === "ENOENT") { res.writeHead(404); res.end("Not found"); }
    else if (e.message === "Path traversal") { res.writeHead(400); res.end("Bad request"); }
    else { console.error(e); res.writeHead(500); res.end("Internal server error"); }
  }
});

server.listen(PORT, () => {
  console.log(`Lectra dev server running:
  - Site:     http://localhost:${PORT}
  - Files API http://localhost:${PORT}/api/files
  - Notes dir ${NOTES_DIR}`);
});
