/*
This software copyright (c) 2026 stevenrugg.dev LLC - All Rights Reserved

This software may not be not be modified in full or in part, or used for commercial purposes. See 
license in the root of this project directory for details. 

*/







'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LANGUAGES, getLanguageName } from '@/lib/languages';
import { formatSrt, formatTxt, type TranscriptChunk } from '@/lib/transcript';
import type { DiscoveredStream } from '@/lib/discover';

type Phase = 'idle' | 'discovering' | 'discovered' | 'transcribing' | 'stopped' | 'error';

export default function HomePage() {
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('en');
  const [phase, setPhase] = useState<Phase>('idle');
  const [streams, setStreams] = useState<DiscoveredStream[]>([]);
  const [activeStream, setActiveStream] = useState<DiscoveredStream | null>(null);
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [status, setStatus] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [sessionStart, setSessionStart] = useState<Date | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new chunk
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chunks.length]);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => sourceRef.current?.close();
  }, []);

  const canDiscover = url.trim().length > 0 && phase !== 'discovering' && phase !== 'transcribing';

  async function handleDiscover() {
    setErrorMsg('');
    setStreams([]);
    setActiveStream(null);
    setChunks([]);
    setPhase('discovering');
    setStatus('Scanning for streams…');

    try {
      const res = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Discovery failed (${res.status})`);
      if (!data.streams || data.streams.length === 0) {
        setPhase('error');
        setErrorMsg('No audio or video streams found at that URL.');
        return;
      }
      setStreams(data.streams);
      setPhase('discovered');
      setStatus(`Found ${data.streams.length} stream${data.streams.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setPhase('error');
      setErrorMsg(err instanceof Error ? err.message : 'Discovery failed');
    }
  }

  function startTranscription(stream: DiscoveredStream) {
    setActiveStream(stream);
    setChunks([]);
    setErrorMsg('');
    setPhase('transcribing');
    setStatus('Connecting…');
    setSessionStart(new Date());

    const params = new URLSearchParams({
      streamUrl: stream.url,
      target,
      chunk: '30',
    });
    const es = new EventSource(`/api/transcribe?${params}`);
    sourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'status') {
          setStatus(ev.message);
        } else if (ev.type === 'chunk') {
          setChunks((prev) => [...prev, ev]);
        } else if (ev.type === 'error') {
          setErrorMsg(ev.message);
        } else if (ev.type === 'done') {
          es.close();
          sourceRef.current = null;
          setPhase('stopped');
          setStatus('Session ended.');
        }
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect on transient errors; only treat as
      // fatal if the connection is fully closed.
      if (es.readyState === EventSource.CLOSED) {
        setPhase('stopped');
        setStatus('Connection closed.');
      }
    };
  }

  function stopTranscription() {
    sourceRef.current?.close();
    sourceRef.current = null;
    setPhase('stopped');
    setStatus('Session stopped.');
  }

  function reset() {
    sourceRef.current?.close();
    sourceRef.current = null;
    setUrl('');
    setStreams([]);
    setActiveStream(null);
    setChunks([]);
    setStatus('');
    setErrorMsg('');
    setPhase('idle');
    setSessionStart(null);
  }

  function downloadTxt() {
    if (!activeStream || !sessionStart) return;
    const text = formatTxt(chunks, {
      streamUrl: activeStream.url,
      targetLang: getLanguageName(target),
      startedAt: sessionStart,
    });
    download(text, `streamscribe-${stamp(sessionStart)}.txt`, 'text/plain');
  }

  function downloadSrt() {
    if (!activeStream || !sessionStart) return;
    const srt = formatSrt(chunks, true);
    download(srt, `streamscribe-${stamp(sessionStart)}.srt`, 'application/x-subrip');
  }

  const totalDuration = useMemo(() => {
    if (chunks.length === 0) return '00:00:00';
    const last = chunks[chunks.length - 1];
    const ms = last.startedAt + last.durationMs;
    const totalSec = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }, [chunks]);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-6 md:px-10 py-10 md:py-16">
      {/* Header */}
      <header className="mb-12 md:mb-16">
        <div className="flex items-baseline justify-between flex-wrap gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.25em] text-ink/60 mb-3">
              Vol.01 — Live Translation Pipeline
            </p>
            <h1 className="font-display font-light text-6xl md:text-8xl leading-[0.95] tracking-tight">
              Stream<span className="italic font-normal text-rust">Scribe</span>
            </h1>
          </div>
          <p className="font-display italic text-lg md:text-xl text-ink/70 max-w-sm leading-snug">
            Paste a URL. Pick a language.<br />
            Watch the words arrive.
          </p>
        </div>
        <div className="mt-8 h-px bg-ink/20" />
      </header>

      {/* Input row */}
      <section className="mb-10">
        <div className="grid md:grid-cols-[1fr_auto_auto] gap-3 items-stretch">
          <div className="relative">
            <label className="absolute -top-2 left-3 px-2 bg-bone font-mono text-[10px] uppercase tracking-widest text-ink/60">
              Source URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canDiscover) handleDiscover();
              }}
              placeholder="https://www.iranintl.com/en  ·  https://youtube.com/live/...  ·  *.m3u8"
              disabled={phase === 'transcribing' || phase === 'discovering'}
              className="w-full px-4 py-4 bg-transparent border border-ink/30 rounded-none font-mono text-sm focus:outline-none focus:border-ink focus:ring-0 disabled:opacity-50 placeholder:text-ink/30"
            />
          </div>

          <div className="relative">
            <label className="absolute -top-2 left-3 px-2 bg-bone font-mono text-[10px] uppercase tracking-widest text-ink/60">
              Translate to
            </label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={phase === 'transcribing'}
              className="h-full px-4 py-4 bg-transparent border border-ink/30 font-mono text-sm focus:outline-none focus:border-ink min-w-[200px] disabled:opacity-50 cursor-pointer appearance-none pr-10"
              style={{
                backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M2 4l4 4 4-4' stroke='%230a0a0a' fill='none' stroke-width='1.5'/></svg>")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 1rem center',
              }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} — {l.nativeName}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleDiscover}
            disabled={!canDiscover}
            className="px-8 py-4 bg-ink text-bone font-mono text-xs uppercase tracking-[0.2em] hover:bg-rust transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {phase === 'discovering' ? 'Scanning…' : 'Find Streams'}
          </button>
        </div>

        {(status || errorMsg) && (
          <div className="mt-4 flex items-center gap-3 font-mono text-xs">
            {phase === 'transcribing' && (
              <span className="inline-block w-2 h-2 rounded-full bg-rust live-dot" />
            )}
            <span className={errorMsg ? 'text-rust' : 'text-ink/70'}>
              {errorMsg || status}
            </span>
          </div>
        )}
      </section>

      {/* Discovered streams (after find, before start) */}
      {phase === 'discovered' && streams.length > 0 && (
        <section className="mb-10">
          <h2 className="font-display text-2xl mb-4">
            <span className="italic text-ink/60">Found</span> {streams.length} stream{streams.length === 1 ? '' : 's'}
          </h2>
          <div className="grid md:grid-cols-2 gap-3">
            {streams.map((s, i) => (
              <button
                key={i}
                onClick={() => startTranscription(s)}
                className="text-left p-5 border border-ink/20 hover:border-ink hover:bg-clay/30 transition-all group"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-rust">
                    {s.type} · {s.source}
                  </span>
                  <span className="font-mono text-[10px] text-ink/40 group-hover:text-ink">
                    →
                  </span>
                </div>
                {s.title && (
                  <p className="font-display text-base mb-2 line-clamp-2">{s.title}</p>
                )}
                <p className="font-mono text-[11px] text-ink/60 break-all line-clamp-2">
                  {s.url}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Active session: live transcript */}
      {(phase === 'transcribing' || phase === 'stopped') && activeStream && (
        <section>
          <div className="flex items-baseline justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="font-display text-3xl">
                {phase === 'transcribing' ? (
                  <>
                    <span className="italic text-ink/60">Listening to</span>{' '}
                    <span className="text-rust">·</span> {getLanguageName(target)}
                  </>
                ) : (
                  <>
                    <span className="italic text-ink/60">Session ended</span>
                  </>
                )}
              </h2>
              <p className="font-mono text-[11px] text-ink/50 mt-1 break-all">
                {activeStream.url}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-ink/60">
                {chunks.length} chunk{chunks.length === 1 ? '' : 's'} · {totalDuration}
              </span>
              {phase === 'transcribing' && (
                <button
                  onClick={stopTranscription}
                  className="px-4 py-2 border border-rust text-rust font-mono text-[10px] uppercase tracking-widest hover:bg-rust hover:text-bone transition-colors"
                >
                  Stop
                </button>
              )}
              {phase === 'stopped' && (
                <button
                  onClick={reset}
                  className="px-4 py-2 border border-ink font-mono text-[10px] uppercase tracking-widest hover:bg-ink hover:text-bone transition-colors"
                >
                  New Session
                </button>
              )}
              <button
                onClick={downloadTxt}
                disabled={chunks.length === 0}
                className="px-4 py-2 bg-ink text-bone font-mono text-[10px] uppercase tracking-widest hover:bg-moss disabled:opacity-30 transition-colors"
              >
                .txt
              </button>
              <button
                onClick={downloadSrt}
                disabled={chunks.length === 0}
                className="px-4 py-2 bg-ink text-bone font-mono text-[10px] uppercase tracking-widest hover:bg-moss disabled:opacity-30 transition-colors"
              >
                .srt
              </button>
            </div>
          </div>

          <div className="border border-ink/20 bg-bone/40 backdrop-blur-sm">
            <div className="transcript-scroll max-h-[60vh] overflow-y-auto p-6 md:p-10">
              {chunks.length === 0 && phase === 'transcribing' && (
                <div className="font-display italic text-ink/40 text-lg py-12 text-center">
                  Waiting for the first chunk… (audio captures in {30}-second segments)
                </div>
              )}
              {chunks.length === 0 && phase === 'stopped' && (
                <div className="font-display italic text-ink/40 text-lg py-12 text-center">
                  Session ended before any chunks were transcribed.
                </div>
              )}
              {chunks.map((c) => (
                <article key={c.index} className="chunk-reveal mb-8 last:mb-0">
                  <div className="flex items-baseline gap-3 mb-2">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-ink/40">
                      {msToClock(c.startedAt)}
                    </span>
                    {c.detectedLanguage && c.detectedLanguage !== target && (
                      <span className="font-mono text-[10px] text-rust">
                        {c.detectedLanguage} → {target}
                      </span>
                    )}
                  </div>
                  <p className="font-display text-lg md:text-xl leading-relaxed">
                    {c.translatedText || (
                      <span className="italic text-ink/30">[silence]</span>
                    )}
                  </p>
                  {c.sourceText &&
                    c.sourceText.trim() !== c.translatedText.trim() && (
                      <p className="mt-2 font-mono text-[11px] text-ink/40 leading-relaxed border-l-2 border-clay pl-3">
                        {c.sourceText}
                      </p>
                    )}
                </article>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        </section>
      )}

      {/* Idle hint */}
      {phase === 'idle' && (
        <section className="mt-20 grid md:grid-cols-3 gap-8 max-w-5xl">
          <Step
            n="01"
            title="Paste"
            body="A page URL, a YouTube live link, or a raw .m3u8. We'll work out the rest."
          />
          <Step
            n="02"
            title="Choose"
            body="Twenty target languages. Whisper transcribes in the source language; gpt-4o-mini renders the result."
          />
          <Step
            n="03"
            title="Watch"
            body="Thirty-second chunks arrive in real time. Stop whenever; download .txt or .srt."
          />
        </section>
      )}

      <footer className="mt-24 pt-8 border-t border-ink/20 font-mono text-[10px] uppercase tracking-widest text-ink/50 flex justify-between flex-wrap gap-2">
        <span>Built with Next.js by Steven Rugg - © 2026 stevenrugg.dev LLC All rights reserved · ffmpeg · Whisper · gpt-4o-mini</span>
        <span>Local pipeline · audio purged after transcription</span>
      </footer>
    </main>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <span className="font-mono text-xs text-rust">{n}</span>
      <h3 className="font-display text-3xl mt-1 mb-2">{title}</h3>
      <p className="text-sm text-ink/70 leading-relaxed">{body}</p>
    </div>
  );
}

function msToClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
