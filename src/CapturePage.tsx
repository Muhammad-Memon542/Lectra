import React, { useEffect, useRef, useState } from "react";
// 🔧 Adjust this import path to your Firebase init (compat SDK or default export)
// For compat (v8 style):
//   import firebase from "../db";
// For modular (v9) replace the helper `uploadArchiveToFirebase` with modular calls (see comment there).
// @ts-ignore
import { storage } from "./firebase";
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

/**
 * Lectra – Audio preview + periodic snapshots → ZIP-like TAR.GZ → Upload to Firebase Storage
 * -------------------------------------------------------------------------------------------
 * • No servers, no directory pickers.
 * • Buffers snapshots in memory during recording.
 * • On stop: builds a .tar.gz archive and uploads to Firebase Storage at:
 *      sessions/<sessionId>/session-<sessionId>.tar.gz
 * • Keeps mic level meter and Web Speech API transcript (optional payload to upload later).
 */

declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
    webkitSpeechRecognitionEvent?: any;
    SpeechRecognitionEvent?: any;
    __LECTRA_RUN_TESTS__?: boolean;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

type TranscriptPiece = { text: string; startMs: number; endMs: number; final: boolean };

type MediaErrorKind = "denied" | "insecure" | "notfound" | "overconstrained" | "abort" | "other";

function genSessionId() {
  return (
    crypto?.randomUUID?.() ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    })
  ).toString();
}

function isLikelyInsecureContext(win: any): boolean {
  try {
    const hostname = win?.location?.hostname || "";
    const secure = win?.isSecureContext === true;
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname);
    return !(secure || isLocal);
  } catch {
    return true;
  }
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

  const [sessionId, setSessionId] = useState(genSessionId());
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [framesBuffered, setFramesBuffered] = useState(0);
  const [durationSec, setDurationSec] = useState(120);
  const [frameIntervalSec, setFrameIntervalSec] = useState(5);
  const [remaining, setRemaining] = useState(durationSec);
  const [error, setError] = useState<string | null>(null);

  // Speech API
  const [speechSupported, setSpeechSupported] = useState(false);
  const [transcriptPieces, setTranscriptPieces] = useState<TranscriptPiece[]>([]);
  const [transcriptText, setTranscriptText] = useState("");

  // Media and UI refs
  const mediaRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

  // local buffered frames for the archive
  const framesLocalRef = useRef<Array<{ name: string; blob: Blob }>>([]);

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

  function cleanupAll() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    try { recognitionRef.current?.stop?.(); } catch {}
    analyzerRef.current?.disconnect();
    audioCtxRef.current?.close();
    mediaRef.current?.getTracks().forEach((t) => t.stop());
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
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      const AudioCtx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512;
      source.connect(analyser);
      audioCtxRef.current = audioCtx; analyzerRef.current = analyser; tickLevel();
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
    rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    rec.onstart = () => { sessionStartMsRef.current = performance.now(); };
    rec.onresult = (e: any) => {
      const pieces: TranscriptPiece[] = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0]?.transcript?.trim?.() || ""; if (!txt) continue;
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

  function stopSpeechRecognition() { try { recognitionRef.current?.stop?.(); } catch {} recognitionRef.current = null; }

  async function startRecording() {
    setError(null);
    setFramesBuffered(0);
    framesLocalRef.current = []; frameIndexRef.current = 0;

    if (!ready) { try { await initMedia(); } catch { return; } }

    // snapshot loop only
    startSnapshotLoop();

    // speech transcript
    startSpeechRecognition();

    // countdown + auto-stop
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
    setStatus("Recording… (buffering snapshots)");
  }

  function startSnapshotLoop(){
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    frameTimerRef.current = window.setInterval(captureFrameToMemory, Math.max(1000, frameIntervalSec * 1000));
  }

  async function captureFrameToMemory(){
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
      canvas.toBlob((blob) => {
        if (!blob) return;
        framesLocalRef.current.push({ name: filename, blob });
        setFramesBuffered(n => n + 1);
      }, 'image/png');
    } catch (e) { console.error('snapshot error', e); }
  }

  async function stopRecording() {
    if (!recording) return;
    setStatus("Stopping…");
    if (frameTimerRef.current) { clearInterval(frameTimerRef.current); frameTimerRef.current = null; }
    if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    stopSpeechRecognition();
    setRecording(false);

    try {
      setStatus("Finalizing archive…");
      const tarBlob = await buildTar(framesLocalRef.current);
      setStatus("Uploading to Firebase Storage…");
      const url = await uploadArchive(sessionId, tarBlob);
      setStatus("Uploaded ✅");
      console.info("Firebase download URL:", url);
    } catch (e:any) {
      console.error(e);
      setError("Upload failed. Check Firebase config/permissions.");
      setStatus("Upload error");
    }
  }

  function resetSession() {
    if (recording) return;
    setSessionId(genSessionId());
    setStatus("New session ready");
    setFramesBuffered(0);
    framesLocalRef.current = [];
    setTranscriptPieces([]); setTranscriptText("");
    setRemaining(durationSec);
  }

  // ===== TAR builder (gzips when CompressionStream exists) =====
  async function buildTar(files: Array<{ name: string; blob: Blob }>): Promise<Blob> {
    const encoder = new TextEncoder();
    const BLOCK = 512;
    function octal(value: number, length: number) {
      const s = value.toString(8);
      const body = s.padStart(length - 1, '0');
      return encoder.encode(body + '\0');
    }
    function put(view: Uint8Array, offset: number, data: Uint8Array) { view.set(data.subarray(0, data.length), offset); }
    function headerFor(name: string, size: number, mtime: number): Uint8Array {
      const buf = new Uint8Array(BLOCK);
      put(buf, 0, encoder.encode(name).subarray(0, 100));
      put(buf, 100, encoder.encode('0000777\0'));
      put(buf, 108, encoder.encode('0000000\0'));
      put(buf, 116, encoder.encode('0000000\0'));
      put(buf, 124, octal(size, 12));
      put(buf, 136, octal(Math.floor(mtime / 1000), 12));
      for (let i = 148; i < 156; i++) buf[i] = 0x20;
      buf[156] = '0'.charCodeAt(0);
      put(buf, 257, encoder.encode('ustar\0'));
      put(buf, 263, encoder.encode('00'));
      put(buf, 265, encoder.encode('user'));
      put(buf, 297, encoder.encode('group'));
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
      const chk = encoder.encode(sum.toString(8).padStart(6, '0') + '\0 ');
      put(buf, 148, chk);
      return buf;
    }
    function padToBlock(n: number) { const rem = n % 512; return rem === 0 ? 0 : 512 - rem; }

    const parts: Array<Uint8Array> = [];
    for (const f of files) {
      const ab = new Uint8Array(await f.blob.arrayBuffer());
      const head = headerFor(f.name, ab.length, Date.now());
      parts.push(head, ab);
      const pad = padToBlock(ab.length);
      if (pad) parts.push(new Uint8Array(pad));
    }
    parts.push(new Uint8Array(512), new Uint8Array(512));

    const total = parts.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    const tarBlob = new Blob([out], { type: 'application/x-tar' });

    if (typeof (window as any).CompressionStream === 'function') {
      try {
        const cs = new (window as any).CompressionStream('gzip');
        const gzStream = (tarBlob as any).stream().pipeThrough(cs);
        const gzResp = new Response(gzStream);
        return await gzResp.blob();
      } catch { return tarBlob; }
    }
    return tarBlob;
  }

  // // ===== Firebase upload (compat SDK). For v9 modular, see comment below. =====
  // async function uploadArchiveToFirebase(tarBlob: Blob): Promise<string> {
  //   // COMPAT (v8 / compat):
  //   const storageRef = firebase.storage().ref();
  //   const path = `sessions/${sessionId}/session-${sessionId}.tar.gz`;
  //   const fileRef = storageRef.child(path);
  //   const snapshot = await fileRef.put(tarBlob, { contentType: 'application/gzip' });
  //   const url = await snapshot.ref.getDownloadURL();
  //   return url;

  //   // MODULAR (v9):
  //   // import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
  //   // const storage = getStorage();
  //   // const fileRef = ref(storage, `sessions/${sessionId}/session-${sessionId}.tar.gz`);
  //   // const snap = await uploadBytes(fileRef, tarBlob, { contentType: 'application/gzip' });
  //   // return await getDownloadURL(snap.ref);
  // }
  
  async function uploadArchive(sessionId: string, tarGz: Blob) {
    const path = `sessions/${sessionId}/session-${sessionId}.tar.gz`;
    const fileRef = ref(storage, path);
    const snap = await uploadBytes(fileRef, tarGz, { contentType: "application/gzip" });
    return await getDownloadURL(snap.ref);
  }

  const box: React.CSSProperties = { border: `1px solid ${theme.border}`, borderRadius: 16, padding: 16, background: theme.card };
  const btn = (disabled=false, grad?: string): React.CSSProperties => ({ padding: "12px 16px", borderRadius: 12, border: `1px solid ${theme.border}`, fontWeight: 700, cursor: disabled? "not-allowed":"pointer", opacity: disabled? 0.6:1, background: grad || theme.muted, color: grad? "#0b0e2c": theme.fg });
  const label = { fontSize: 12, color: theme.mutedText } as const;

  const insecure = isLikelyInsecureContext(window);

  return (
    <div style={{minHeight:'100vh', background: theme.bg, color: theme.fg, padding: 24}}>
      <div style={{maxWidth: 980, margin: '0 auto'}}>
        <header style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap: 12, marginBottom: 16}}>
          <h1 style={{margin:0, fontSize: 28, fontWeight: 800}}>Lectra · Snapshots → Firebase Upload</h1>
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

            <section style={box}>
              <div style={label}>Controls</div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:8}}>
                {!ready && (
                  <button style={btn(insecure, `linear-gradient(135deg, ${theme.bolt}, ${theme.lime})`)} onClick={initMedia} disabled={insecure}>🔒 Enable mic & camera</button>
                )}
                <button style={btn(!ready || recording, `linear-gradient(135deg, ${theme.bolt}, ${theme.lime})`)} onClick={startRecording} disabled={!ready || recording}>⏺ Start</button>
                <button style={btn(!recording, `linear-gradient(135deg, ${theme.blue}, ${theme.charcoal})`)} onClick={stopRecording} disabled={!recording}>⏹ Stop</button>
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
                <div style={{fontSize:14, marginTop:4}}>Snapshots buffered: <code>{framesBuffered}</code></div>
                {recording && <div style={{fontSize:14, marginTop:4}}>Time left: <code>{remaining}s</code></div>}
                {error && <div style={{marginTop:8, color:'#ffb1b1', fontSize:13}}>{error}</div>}
                {!speechSupported && <div style={{marginTop:8, color:'#ffdc7b', fontSize:13}}>⚠️ SpeechRecognition not supported. Transcript will be empty.</div>}
              </div>
            </section>
          </div>

          <section style={{...box, gridColumn: '1 / -1'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
              <div style={{...label, fontSize:13}}>Live Transcript (Web Speech API)</div>
              <div style={{fontSize:12, opacity:0.8}}>{transcriptText.length ? `${transcriptText.length} chars` : '—'}</div>
            </div>
            <div style={{marginTop:8, maxHeight:160, overflow:'auto', padding:12, border:`1px solid ${theme.border}`, borderRadius:12, background: theme.muted}}>
              <div style={{whiteSpace:'pre-wrap'}}>{transcriptText || '• Click “Enable mic & camera” then “Start” to begin.'} </div>
            </div>
          </section>
        </div>

        <footer style={{marginTop:16, opacity:0.8, fontSize:12}}>
          On stop, we bundle all snapshots into <code>session-{sessionId}.tar.gz</code> and upload to Firebase Storage at <code>sessions/{sessionId}/</code>.
        </footer>
      </div>
      <canvas ref={canvasRef} style={{ display:'none' }} />
    </div>
  );
}
