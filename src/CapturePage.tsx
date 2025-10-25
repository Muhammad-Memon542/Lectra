import React, { useEffect, useRef, useState } from "react";

/**
 * Lectra – Part 1: Capture & Uploader (Frontend)
 * -------------------------------------------------
 * ✅ FIX: Avoid runtime access to `process` in the browser.
 *   - We now resolve API base URL via a safe helper with multiple fallbacks:
 *       1) window.__LECTRA_API_BASE__ (set this in a script tag if needed)
 *       2) <meta name="lectra-api-base" content="https://api.example.com"> (add in <head>)
 *       3) process.env.NEXT_PUBLIC_API_BASE (guarded behind typeof check; works in Next.js build-time replacement)
 *       4) default: "" (same-origin relative /api)
 *
 * What this component does
 * - Requests mic + camera permissions
 * - Shows live preview
 * - Records WebM (vp8/opus) via MediaRecorder in rolling chunks (default 15s)
 * - Uploads each chunk to /api/ingest/chunk with a sessionId
 * - On Stop, calls /api/ingest/finalize to merge & kick off STT
 * - Resilient queue with retries & exponential backoff
 * - Basic audio level meter & upload stats
 *
 * How to use
 * - Run `npm install` then `npm run start:all` (starts API on :8787 and Vite on :5173)
 * - The dev server proxies `/api` to `http://localhost:8787`.
 */

// (Ambient) prevent TS errors if no @types/node
declare const process: any; // eslint-disable-line

type EnvLike = { win?: any; doc?: Document | null; proc?: any };

export function resolveApiBaseCore(env: EnvLike): string {
  const w = env.win;
  if (w && typeof w.__LECTRA_API_BASE__ === "string" && w.__LECTRA_API_BASE__.length > 0) {
    return w.__LECTRA_API_BASE__ as string;
  }
  const d = env.doc;
  if (d) {
    const meta = d.querySelector('meta[name="lectra-api-base"]') as HTMLMetaElement | null;
    if (meta?.content) return meta.content.trim();
  }
  const p = env.proc;
  if (p && p.env && typeof p.env.NEXT_PUBLIC_API_BASE === "string" && p.env.NEXT_PUBLIC_API_BASE.length > 0) {
    return p.env.NEXT_PUBLIC_API_BASE as string;
  }
  return "";
}

export function resolveApiBase(): string {
  const proc = (typeof process !== "undefined" ? process : undefined);
  const win = (typeof window !== "undefined" ? (window as any) : undefined);
  const doc = (typeof document !== "undefined" ? document : undefined);
  return resolveApiBaseCore({ win, doc, proc });
}

const API_BASE = resolveApiBase();

function prettyBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"]; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
}

function genSessionId() {
  return (crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16);
  })).toString();
}

class UploadQueue {
  private q: Array<() => Promise<void>> = [];
  private working = false;
  enqueue(task: () => Promise<void>) { this.q.push(task); this.run(); }
  async run() {
    if (this.working) return;
    this.working = true;
    while (this.q.length) {
      const task = this.q.shift()!;
      try { await task(); } catch (e) { console.error("Upload task failed permanently:", e); }
    }
    this.working = false;
  }
}

const queue = new UploadQueue();

async function withRetry<T>(fn: () => Promise<T>, opts = { retries: 5, baseMs: 600 }) {
  let attempt = 0; let err: any;
  while (attempt < (opts.retries ?? 0)) {
    try { return await fn(); } catch (e) { err = e; }
    const delay = (opts.baseMs ?? 600) * Math.pow(2, attempt) + Math.random() * 200;
    await new Promise(r => setTimeout(r, delay));
    attempt++;
  }
  throw err;
}

export default function CapturePage() {
  const [sessionId, setSessionId] = useState<string>(() => genSessionId());
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<string>("Idle");
  const [bytesSent, setBytesSent] = useState(0);
  const [chunksSent, setChunksSent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [chunkMs, setChunkMs] = useState<number>(15000);

  const mediaRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const levelRef = useRef<HTMLDivElement | null>(null);
  const chunkIndexRef = useRef<number>(0);

  useEffect(() => {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        mediaRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        const AudioCtx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        audioCtxRef.current = audioCtx;
        analyzerRef.current = analyser;
        tickLevel();
        setReady(true);
        setStatus("Devices ready");
      } catch (e: any) {
        console.error(e);
        setError("Permissions denied or devices unavailable.");
        setStatus("Error");
      }
    })();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      analyzerRef.current?.disconnect();
      audioCtxRef.current?.close();
      mediaRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  function tickLevel() {
    const analyser = analyzerRef.current; const bar = levelRef.current;
    if (!analyser || !bar) { rafRef.current = requestAnimationFrame(tickLevel); return; }
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const pct = Math.min(100, Math.max(2, (avg / 255) * 100));
    bar.style.width = pct + "%";
    rafRef.current = requestAnimationFrame(tickLevel);
  }

  async function startRecording() {
    setError(null);
    setBytesSent(0); setChunksSent(0);
    chunkIndexRef.current = 0;

    const stream = mediaRef.current;
    if (!stream) return setError("No media stream.");

    const mimeType = getBestMime();
    const rec = new MediaRecorder(stream, { mimeType });
    recRef.current = rec;

    rec.onstart = () => setStatus("Recording…");
    rec.onerror = (ev) => { console.error(ev); setError("Recorder error"); };

    rec.ondataavailable = async (e: BlobEvent) => {
      if (!e.data || !e.data.size) return;
      const idx = chunkIndexRef.current++;
      const filename = `part-${String(idx).padStart(5, "0")}.webm`;
      const body = new FormData();
      body.append("chunk", e.data, filename);
      body.append("sessionId", sessionId);

      const task = async () => {
        await withRetry(() => fetch(`${API_BASE}/api/ingest/chunk`, { method: "POST", body }), { retries: 5, baseMs: 600 });
        setChunksSent((n) => n + 1);
        setBytesSent((b) => b + e.data.size);
      };
      queue.enqueue(task);
    };

    rec.start(chunkMs);
    setRecording(true);
  }

  async function stopRecording() {
    const rec = recRef.current; if (!rec) return;
    setStatus("Stopping…");
    rec.stop();
    setRecording(false);

    setTimeout(async () => {
      setStatus("Finalizing…");
      try {
        await withRetry(() => fetch(`${API_BASE}/api/ingest/finalize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId })
        }), { retries: 5, baseMs: 800 });
        setStatus("Uploaded & finalized ✅");
      } catch (e: any) {
        console.error(e);
        setError("Finalize failed. Server unreachable?");
        setStatus("Finalize error");
      }
    }, 500);
  }

  function getBestMime() {
    const candidates = [
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
      "audio/webm;codecs=opus"
    ];
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  }

  function resetSession() {
    if (recording) return;
    setSessionId(genSessionId());
    setStatus("New session ready");
    setBytesSent(0); setChunksSent(0);
  }

  return (
    <div style={{padding: '16px', color: 'white', background: '#0b0e2c', minHeight: '100vh'}}>
      <div style={{maxWidth: 920, margin: '0 auto'}}>
        <h1>Lectra · Recorder</h1>
        <div>Session: <code>{sessionId}</code></div>

        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12}}>
          <section style={{border: '1px solid #334', borderRadius: 12, padding: 12}}>
            <h2>Live Preview</h2>
            <div style={{borderRadius: 10, overflow: 'hidden', background: 'black', aspectRatio: '16/9'}}>
              <video ref={videoRef} style={{width: '100%', height: '100%', objectFit: 'cover'}} muted playsInline />
            </div>
            <div style={{marginTop: 10}}>
              <div>Mic level</div>
              <div style={{height: 8, width: '100%', borderRadius: 999, background: '#223', border: '1px solid #334'}}>
                <div ref={levelRef} style={{height: '100%', width: '4%', borderRadius: 999, background: 'linear-gradient(90deg,#2D6EEA,#7CFF6B)'}}/>
              </div>
            </div>
          </section>

          <section style={{border: '1px solid #334', borderRadius: 12, padding: 12}}>
            <h2>Controls</h2>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <button onClick={startRecording} disabled={!ready || recording}>⏺ Start</button>
              <button onClick={stopRecording} disabled={!recording}>⏹ Stop & Finalize</button>
            </div>

            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10}}>
              <label>Chunk length (seconds)
                <input type="number" min={5} max={60} step={5}
                  value={Math.round(chunkMs / 1000)}
                  onChange={(e) => setChunkMs(Math.max(5000, Math.min(60000, Number(e.target.value) * 1000)))}
                />
              </label>
              <div style={{display: 'flex', justifyContent: 'flex-end', alignItems: 'end'}}>
                <button onClick={resetSession} disabled={recording}>New session</button>
              </div>
            </div>

            <div style={{marginTop: 10, padding: 8, border: '1px solid #334', borderRadius: 10, background: '#0b0f22'}}>
              <div>Status: <b>{status}</b></div>
              <div>Uploaded: <code>{chunksSent} chunks</code> · <code>{prettyBytes(bytesSent)}</code></div>
            </div>

            {error && <div style={{marginTop: 8, color: '#ff8b8b'}}>{error}</div>}
          </section>
        </div>

        <footer style={{marginTop: 16, opacity: 0.8, fontSize: 12}}>
          Uses MediaRecorder → POST /api/ingest/chunk. On stop → POST /api/ingest/finalize.
        </footer>
      </div>
    </div>
  );
}

// DEV TESTS
export function __runResolveApiBaseTests() {
  const cases: Array<{name:string, env: EnvLike, expect: string}> = [
    { name: "window override wins", env: { win: { __LECTRA_API_BASE__: "https://win.example" }, doc: null, proc: null }, expect: "https://win.example" },
    { name: "meta fallback", env: { win: {}, doc: (() => { const d = document.implementation.createHTMLDocument(""); const m = d.createElement("meta"); m.setAttribute("name","lectra-api-base"); m.setAttribute("content","https://meta.example"); d.head.appendChild(m); return d; })(), proc: null }, expect: "https://meta.example" },
    { name: "process env fallback", env: { win: {}, doc: null as any, proc: { env: { NEXT_PUBLIC_API_BASE: "https://env.example" } } }, expect: "https://env.example" },
    { name: "default empty", env: { win: {}, doc: null, proc: null }, expect: "" }
  ];
  const results = cases.map(c => ({ name: c.name, got: resolveApiBaseCore(c.env), expect: c.expect }));
  const pass = results.every(r => r.got === r.expect);
  console.table(results);
  if (!pass) throw new Error("resolveApiBaseCore tests failed");
  return pass;
}
if (typeof window !== "undefined" && (window as any).__LECTRA_RUN_TESTS__) {
  try { __runResolveApiBaseTests(); console.info("✔ resolveApiBaseCore tests passed"); }
  catch (e) { console.error(e); }
}
