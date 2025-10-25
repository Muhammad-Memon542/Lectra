import React, { useEffect, useRef, useState } from "react";

/**
 * Lectra – Local-only recorder + periodic snapshots (NO uploads)
 * ----------------------------------------------------------------
 * What changed vs your last version:
 *  - Removed ALL network uploads (/api/ingest/*) and Gradient calls.
 *  - Does NOT bundle & auto-download at the end.
 *  - Uses the File System Access API to save each snapshot immediately
 *    to a user-picked directory, inside a folder named `my_picsssss/session-<id>`.
 *  - Keeps mic level meter and in-browser Web Speech API transcript.
 *  - Still requests mic/cam ONLY on user gesture and handles insecure contexts.
 *
 * Notes:
 *  - Chrome/Edge (desktop) support showDirectoryPicker(). Firefox/Safari do not (yet).
 *  - The browser cannot write to your project "source code" folder automatically.
 *    You will be prompted once to choose a folder on disk where we create `my_picsssss/`.
 */

// Type guards for vendor-prefixed SpeechRecognition
declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
    webkitSpeechRecognitionEvent?: any;
    SpeechRecognitionEvent?: any;
    __LECTRA_RUN_TESTS__?: boolean;
  }
}

// (Ambient) prevent TS errors if no @types/node
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

type EnvLike = { win?: any; doc?: Document | null; proc?: any };

type TranscriptPiece = {
  text: string;
  startMs: number; // relative to sessionStartMs
  endMs: number;   // updated when final
  final: boolean;
};

type MediaErrorKind =
  | "denied"
  | "insecure"
  | "notfound"
  | "overconstrained"
  | "abort"
  | "other";

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

function isLikelyInsecureContext(win: any): boolean {
  try {
    const hostname = win?.location?.hostname || "";
    const secure = win?.isSecureContext === true;
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname);
    return !(secure || isLocal);
  } catch { return true; }
}

function categorizeMediaError(e: any, win: any): MediaErrorKind {
  const name = (e?.name || "").toLowerCase();
  const msg = (e?.message || "").toLowerCase();
  if (name === "notallowederror" || name === "securityerror" || msg.includes("permission") || msg.includes("denied")) {
    if (isLikelyInsecureContext(win)) return "insecure";
    return "denied";
  }
  if (name === "notfounderror" || msg.includes("no capture devices")) return "notfound";
  if (name === "overconstrainederror" || name === "constraintserror") return "overconstrained";
  if (name === "aborterror") return "abort";
  return "other";
}

export default function CapturePage() {
  // Theme tokens for preview
  const theme = {
    bg: "#0B0E2C",
    fg: "#F4F7FF",
    card: "#0f1429",
    border: "rgba(255,255,255,0.12)",
    muted: "#0b0f22",
    mutedText: "#BBD1FF",
    bolt: "#FFD60A",
    lime: "#7CFF6B",
    blue: "#2D6EEA",
    charcoal: "#111418",
  } as const;

  const [sessionId, setSessionId] = useState<string>(() => genSessionId());
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<string>("Idle");
  const [framesSaved, setFramesSaved] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<number>(120); // default 2 min
  const [frameIntervalSec, setFrameIntervalSec] = useState<number>(5); // default 5s
  const [remaining, setRemaining] = useState<number>(durationSec);

  // Web Speech API support
  const [speechSupported, setSpeechSupported] = useState<boolean>(false);
  const [transcriptPieces, setTranscriptPieces] = useState<TranscriptPiece[]>([]);
  const [transcriptText, setTranscriptText] = useState<string>("");

  // Media refs
  const mediaRef = useRef<MediaStream | null>(null);          // full A+V for preview/snapshots
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // meters / speech
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const levelRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<any | null>(null);
  const sessionStartMsRef = useRef<number>(0);

  // timers
  const frameTimerRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);

  // indices
  const frameIndexRef = useRef<number>(0);

  // Local directory handle for saving files (File System Access API)
  const dirHandleRef = useRef<any | null>(null); // FileSystemDirectoryHandle
  const sessDirHandleRef = useRef<any | null>(null); // FileSystemDirectoryHandle for this session

  useEffect(() => {
    const SR = (window.SpeechRecognition || window.webkitSpeechRecognition);
    setSpeechSupported(!!SR);

    if (isLikelyInsecureContext(window)) {
      setError("This page is not in a secure context. Use HTTPS or localhost before enabling mic/camera.");
      setStatus("Needs HTTPS/localhost");
    }

    return () => cleanupAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanupAll(){
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    try { recognitionRef.current?.stop?.(); } catch {}
    analyzerRef.current?.disconnect();
    audioCtxRef.current?.close();
    mediaRef.current?.getTracks().forEach(t => t.stop());
  }

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

  async function pickDirectoryIfNeeded(): Promise<void> {
    if (sessDirHandleRef.current) return;

    if (!('showDirectoryPicker' in window)) {
      setError("Your browser doesn't support saving directly to a folder. Use Chrome/Edge desktop.");
      throw new Error("no-fsa");
    }

    // Ask user to pick a parent directory once
    if (!dirHandleRef.current) {
      // @ts-ignore
      dirHandleRef.current = await (window as any).showDirectoryPicker({ id: 'lectra-save-root' });
    }
    // Create/ensure my_picsssss/session-<id>
    const root = dirHandleRef.current;
    const pics = await root.getDirectoryHandle('my_picsssss', { create: true });
    const sess = await pics.getDirectoryHandle(`session-${sessionId}`, { create: true });
    sessDirHandleRef.current = sess;
  }

  async function saveBlobToSessionDir(filename: string, blob: Blob): Promise<void> {
    await pickDirectoryIfNeeded();
    const sess = sessDirHandleRef.current;
    const fileHandle = await sess.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async function initMedia(): Promise<void> {
    setStatus("Requesting mic & camera permissions…");
    setError(null);

    if (isLikelyInsecureContext(window)) {
      setStatus("Needs HTTPS/localhost");
      throw new Error("insecure-context");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      mediaRef.current = stream;

      // Video preview
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      // Audio meter
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
      const kind = categorizeMediaError(e, window);
      let message = "";
      if (kind === "insecure") message = "Browser blocked access in an insecure context. Use HTTPS or http://localhost.";
      else if (kind === "denied") message = "Permission denied. Allow mic/camera in the address bar, then Retry.";
      else if (kind === "notfound") message = "No mic/camera found. Connect a device and Retry.";
      else if (kind === "overconstrained") message = "Device constraints couldn't be satisfied. Try defaults and Retry.";
      else if (kind === "abort") message = "Media capture aborted. Retry.";
      else message = `Media error: ${e?.name || e}`;
      setError(message);
      setStatus("Permission needed");
      throw e;
    }
  }

  function startSpeechRecognition() {
    const SR: any = (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { setStatus("Recording… — SpeechRecognition not supported"); return; }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => { sessionStartMsRef.current = performance.now(); };
    rec.onresult = (e: any) => {
      const pieces: TranscriptPiece[] = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0]?.transcript?.trim?.() || "";
        if (!txt) continue;
        pieces.push({ text: txt, startMs: performance.now() - sessionStartMsRef.current, endMs: performance.now() - sessionStartMsRef.current, final: res.isFinal === true });
      }
      if (pieces.length) {
        setTranscriptPieces(prev => {
          const next = [...prev, ...pieces];
          const combined = next.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
          setTranscriptText(combined);
          return next;
        });
      }
    };
    rec.onerror = (ev: any) => { console.warn('SpeechRecognition error', ev); };
    rec.onend = () => {};
    try { rec.start(); } catch (err) { console.warn('SpeechRecognition start failed', err); }
    recognitionRef.current = rec;
  }

  function stopSpeechRecognition() {
    try { recognitionRef.current?.stop?.(); } catch {}
    recognitionRef.current = null;
  }

  async function startRecording() {
    setError(null);
    setFramesSaved(0);
    frameIndexRef.current = 0;

    // Ask for a save directory up-front so we can write snapshots directly
    try { await pickDirectoryIfNeeded(); }
    catch { /* error message already set */ return; }

    // Initialize media ONLY on user gesture here
    if (!ready) {
      try { await initMedia(); }
      catch { return; }
    }

    // Start snapshot loop
    startSnapshotLoop();

    // Start Web Speech API transcription (if supported)
    startSpeechRecognition();

    // Start countdown + auto-stop
    setRemaining(durationSec);
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        const next = Math.max(0, prev - 1);
        if (next === 0 && countdownTimerRef.current) clearInterval(countdownTimerRef.current);
        return next;
      });
    }, 1000);

    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = window.setTimeout(() => { stopRecording(); }, durationSec * 1000);

    setRecording(true);
    setStatus("Recording… (saving snapshots locally)");
  }

  function startSnapshotLoop(){
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    frameTimerRef.current = window.setInterval(captureAndSaveFrame, Math.max(1000, frameIntervalSec * 1000));
  }

  async function captureAndSaveFrame(){
    try {
      const video = videoRef.current; if (!video) return;
      const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
      const w = video.videoWidth || 1280; const h = video.videoHeight || 720;
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const ts = Date.now();
      const idx = frameIndexRef.current++;
      const filename = `frame-${String(idx).padStart(5, '0')}-${ts}.png`;

      canvas.toBlob(async (blob) => {
        if (!blob) return;
        try {
          await saveBlobToSessionDir(filename, blob);
          setFramesSaved(n => n + 1);
        } catch (e) {
          console.error('save frame failed', e);
          setError('Failed to save a snapshot. Check folder permissions.');
        }
      }, 'image/png');
    } catch (e) {
      console.error('snapshot error', e);
    }
  }

  async function stopRecording() {
    if (!recording) return; // already stopped

    setStatus("Stopping…");
    if (frameTimerRef.current) { clearInterval(frameTimerRef.current); frameTimerRef.current = null; }
    if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }

    stopSpeechRecognition();

    setRecording(false);
    setStatus("Stopped ✅ (snapshots saved locally)");
  }

  function resetSession() {
    if (recording) return;
    setSessionId(genSessionId());
    setStatus("New session ready");
    setFramesSaved(0);
    setTranscriptPieces([]); setTranscriptText("");
    setRemaining(durationSec);
    sessDirHandleRef.current = null; // pick dir again for new session folder
  }

  const box: React.CSSProperties = { border: `1px solid ${theme.border}`, borderRadius: 16, padding: 16, background: theme.card } as const;
  const btn = (disabled=false, grad?: string) => ({
    padding: "12px 16px", borderRadius: 12, border: `1px solid ${theme.border}`,
    fontWeight: 700, cursor: disabled? "not-allowed":"pointer", opacity: disabled? 0.6:1,
    background: grad || theme.muted, color: grad? "#0b0e2c": theme.fg
  }) as React.CSSProperties;
  const label = { fontSize: 12, color: theme.mutedText } as const;

  const insecure = isLikelyInsecureContext(window);

  return (
    <div style={{minHeight:'100vh', background: theme.bg, color: theme.fg, padding: 24}}>
      <div style={{maxWidth: 980, margin: '0 auto'}}>
        <header style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap: 12, marginBottom: 16}}>
          <h1 style={{margin:0, fontSize: 28, fontWeight: 800}}>Lectra · Local Snapshots (no uploads)</h1>
          <div style={{opacity:0.85, fontSize: 14}}>Session: <code style={{padding:'2px 6px', border:`1px solid ${theme.border}`, borderRadius:8, background: theme.muted}}>{sessionId}</code></div>
        </header>

        {insecure && (
          <div style={{marginBottom:12, padding:12, border:`1px solid ${theme.border}`, borderRadius:12, background:'#3a1f1f'}}>
            <div style={{fontWeight:700}}>This page is not in a secure context.</div>
            <div style={{fontSize:13, opacity:0.9, marginTop:4}}>Use <code>https://…</code> or run locally on <code>http://localhost</code> to enable mic/camera.</div>
          </div>
        )}

        <div style={{display:'grid', gridTemplateColumns:'1fr', gap:16, alignItems:'start'}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
            {/* Preview */}
            <section style={box}>
              <div style={label}>Camera Preview (used only for snapshots)</div>
              <div style={{marginTop:12, borderRadius:12, overflow:'hidden', background:'#000', aspectRatio:'16/9'}}>
                <video ref={videoRef} style={{width:'100%', height:'100%', objectFit:'cover'}} muted playsInline />
              </div>
              <div style={{marginTop:12}}>
                <div style={{fontSize:12, marginBottom:4}}>Mic level</div>
                <div style={{height:8, width:'100%', borderRadius:999, background: theme.muted, border:`1px solid ${theme.border}`}}>
                  <div ref={levelRef} style={{height:'100%', width:'4%', borderRadius:999, background: `linear-gradient(90deg, ${theme.blue}, ${theme.lime})`}} />
                </div>
              </div>
            </section>

            {/* Controls */}
            <section style={box}>
              <div style={label}>Controls</div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:8}}>
                {!ready && (
                  <button
                    style={btn(insecure, `linear-gradient(135deg, ${theme.bolt}, ${theme.lime})`)}
                    onClick={initMedia} disabled={insecure}>🔒 Enable mic & camera</button>
                )}
                <button
                  style={btn(!ready || recording, `linear-gradient(135deg, ${theme.bolt}, ${theme.lime})`)}
                  onClick={startRecording} disabled={!ready || recording}>⏺ Start</button>
                <button
                  style={btn(!recording, `linear-gradient(135deg, ${theme.blue}, ${theme.charcoal})`)}
                  onClick={stopRecording} disabled={!recording}>⏹ Stop</button>
              </div>

              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12}}>
                <label style={{fontSize:14}}>Snapshot every (seconds)
                  <input type="number" min={2} max={60} step={1}
                    value={frameIntervalSec}
                    onChange={(e) => setFrameIntervalSec(Math.max(2, Math.min(60, Number((e.target as HTMLInputElement).value))))}
                    style={{display:'block', marginTop:6, width:'100%', padding:'8px 10px', borderRadius:10, background: theme.muted, color: theme.fg, border:`1px solid ${theme.border}`}} />
                </label>
                <label style={{fontSize:14}}>Auto-stop after (seconds)
                  <input type="number" min={10} max={7200} step={10}
                    value={durationSec}
                    onChange={(e) => { const v = Math.max(10, Math.min(7200, Number((e.target as HTMLInputElement).value))); setDurationSec(v); setRemaining(v); }}
                    style={{display:'block', marginTop:6, width:'100%', padding:'8px 10px', borderRadius:10, background: theme.muted, color: theme.fg, border:`1px solid ${theme.border}`}} />
                </label>
                <div style={{display:'flex', gap:8, justifyContent:'flex-end', alignItems:'end'}}>
                  <button style={btn(false)} onClick={() => { setError(null); setStatus("Idle"); }}>Clear status</button>
                  <button style={btn(recording)} onClick={resetSession} disabled={recording}>New session</button>
                </div>
              </div>

              <div style={{marginTop:12, padding:12, border:`1px solid ${theme.border}`, borderRadius:12, background: theme.muted}}>
                <div style={{fontSize:14}}>Status: <b>{status}</b></div>
                <div style={{fontSize:14, marginTop:4}}>Snapshots saved: <code>{framesSaved}</code></div>
                {recording && <div style={{fontSize:14, marginTop:4}}>Time left: <code>{remaining}s</code></div>}
                {error && <div style={{marginTop:8, color:'#ffb1b1', fontSize:13}}>{error}</div>}
                {!speechSupported && <div style={{marginTop:8, color:'#ffdc7b', fontSize:13}}>⚠️ Browser SpeechRecognition not supported. Transcript will be empty.</div>}
              </div>
            </section>
          </div>

          {/* Transcript panel */}
          <section style={{...box, gridColumn: '1 / -1'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
              <div style={{...label, fontSize:13}}>Live Transcript (Web Speech API)</div>
              <div style={{fontSize:12, opacity:0.8}}>{transcriptText.length ? `${transcriptText.length} chars` : '—'}</div>
            </div>
            <div style={{marginTop:8, maxHeight:160, overflow:'auto', padding:12, border:`1px solid ${theme.border}`, borderRadius:12, background: theme.muted}}>
              <div style={{whiteSpace:'pre-wrap'}}>{transcriptText || '• Click “Enable mic & camera” then “Start” to begin (Chrome/Edge over HTTPS or localhost).'} </div>
            </div>
          </section>
        </div>

        <footer style={{marginTop:16, opacity:0.8, fontSize:12}}>
          Saves each snapshot directly to <code>my_picsssss/session-{sessionId}</code> inside the folder you pick. No network uploads are performed.
        </footer>
      </div>
      {/* hidden canvas used for snapshots */}
      <canvas ref={canvasRef} style={{ display:'none' }} />
    </div>
  );
}

// DEV TESTS (kept: media error categorization)
export function __runMediaErrorTests() {
  const fakeWinSecure = { isSecureContext: true, location: { hostname: "example.com" } } as any;
  const fakeWinInsecure = { isSecureContext: false, location: { hostname: "example.com" } } as any;
  const cases = [
    { name: 'denied secure', e: { name: 'NotAllowedError', message: 'Permission denied' }, win: fakeWinSecure, expect: 'denied' },
    { name: 'denied insecure', e: { name: 'NotAllowedError', message: 'Permission denied' }, win: fakeWinInsecure, expect: 'insecure' },
    { name: 'notfound', e: { name: 'NotFoundError', message: 'No capture devices' }, win: fakeWinSecure, expect: 'notfound' },
    { name: 'overconstrained', e: { name: 'OverconstrainedError', message: 'constraint' }, win: fakeWinSecure, expect: 'overconstrained' },
    { name: 'abort', e: { name: 'AbortError', message: 'aborted' }, win: fakeWinSecure, expect: 'abort' },
    { name: 'other', e: { name: 'UnknownError', message: 'weird' }, win: fakeWinSecure, expect: 'other' },
  ] as const;
  const results = cases.map(c => ({ name: c.name, got: categorizeMediaError(c.e, c.win), expect: c.expect }));
  console.table(results);
  const pass = results.every(r => r.got === r.expect);
  if (!pass) throw new Error("categorizeMediaError tests failed");
  return pass;
}

if (typeof window !== "undefined" && (window as any).__LECTRA_RUN_TESTS__) {
  try { __runMediaErrorTests(); console.info("✔ categorizeMediaError tests passed"); }
  catch (e) { console.error(e); }
}
