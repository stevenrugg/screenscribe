import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getLanguageName } from './languages';

export type ChunkEvent = {
  type: 'chunk';
  index: number;
  startedAt: number; // ms since session start
  durationMs: number;
  sourceText: string;
  translatedText: string;
  detectedLanguage?: string;
};

export type PipelineEvent =
  | { type: 'status'; message: string }
  | { type: 'error'; message: string }
  | ChunkEvent
  | { type: 'done' };

export type PipelineOptions = {
  streamUrl: string;
  targetLanguageCode: string;
  chunkSeconds?: number;
  signal: AbortSignal; // cancel from the caller (e.g. client disconnect)
  openaiApiKey: string;
};

const WHISPER_MODEL = 'whisper-1';
const TRANSLATE_MODEL = 'gpt-4o-mini';

/**
 * Run the full pipeline as an async iterable of events. The caller drives
 * iteration; we yield as chunks arrive.
 *
 * Lifecycle:
 *   - spawn ffmpeg → segments mp3 chunks into a tmp dir
 *   - poll the dir; chunk N is "done" once N+1 starts being written
 *   - per chunk, transcribe (Whisper) + translate (gpt-4o-mini if non-EN)
 *   - yield a ChunkEvent with both source and translated text
 *   - on abort, kill ffmpeg, drain in-flight chunks, yield 'done'
 */
export async function* runPipeline(opts: PipelineOptions): AsyncGenerator<PipelineEvent> {
  const chunkSeconds = opts.chunkSeconds ?? 30;
  const sessionStart = Date.now();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'streamscribe-'));

  // Queue of events produced by background workers, drained by the generator
  const queue: PipelineEvent[] = [];
  let resolveNext: (() => void) | null = null;
  const push = (ev: PipelineEvent) => {
    queue.push(ev);
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };
  const waitForEvent = () =>
    new Promise<void>((resolve) => {
      resolveNext = resolve;
    });

  let ffmpegProc: ChildProcess | null = null;
  let stopped = false;
  const inFlight = new Set<Promise<void>>();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (ffmpegProc && !ffmpegProc.killed) ffmpegProc.kill('SIGTERM');
  };

  opts.signal.addEventListener('abort', () => {
    push({ type: 'status', message: 'Stopping…' });
    stop();
  });

  // Spawn ffmpeg
  try {
    push({ type: 'status', message: 'Connecting to stream…' });
    ffmpegProc = startFfmpeg(opts.streamUrl, tmpDir, chunkSeconds);
    ffmpegProc.on('exit', (code, signal) => {
      if (!stopped && code !== 0) {
        push({
          type: 'error',
          message: `Stream ended unexpectedly (code=${code} signal=${signal ?? 'none'})`,
        });
      }
      stop();
    });
    ffmpegProc.on('error', (err) => {
      push({ type: 'error', message: `ffmpeg failed to start: ${err.message}` });
      stop();
    });
  } catch (err) {
    push({
      type: 'error',
      message: `Could not start ffmpeg: ${err instanceof Error ? err.message : String(err)}`,
    });
    push({ type: 'done' });
    while (queue.length) yield queue.shift()!;
    return;
  }

  push({ type: 'status', message: 'Capturing audio…' });

  // Watcher: when chunk N+1 appears, chunk N is finalized.
  const watcher = (async () => {
    let nextIndex = 0;
    while (!stopped) {
      const fname = `chunk-${pad(nextIndex)}.mp3`;
      const nname = `chunk-${pad(nextIndex + 1)}.mp3`;
      const fpath = path.join(tmpDir, fname);
      const npath = path.join(tmpDir, nname);

      if (fs.existsSync(fpath) && fs.existsSync(npath)) {
        const idx = nextIndex;
        const startedAt = idx * chunkSeconds * 1000;
        const job = handleChunk(fpath, idx, startedAt, chunkSeconds, opts, push)
          .catch((err) => {
            push({
              type: 'error',
              message: `Chunk ${idx} failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        inFlight.add(job);
        job.finally(() => inFlight.delete(job));
        nextIndex++;
      } else {
        await sleep(750);
      }
    }
  })();

  // Drain events to the consumer
  try {
    while (!stopped || queue.length > 0 || inFlight.size > 0) {
      if (queue.length === 0) {
        await Promise.race([waitForEvent(), sleep(500)]);
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    await stop();
    await watcher.catch(() => {});

    // Pick up any final segments ffmpeg flushed on exit
    try {
      const remaining = (await fsp.readdir(tmpDir))
        .filter((f) => f.endsWith('.mp3'))
        .sort();
      for (const f of remaining) {
        const idx = parseInt(f.match(/chunk-(\d+)/)?.[1] ?? '-1', 10);
        if (idx < 0) continue;
        const startedAt = idx * chunkSeconds * 1000;
        const job = handleChunk(
          path.join(tmpDir, f),
          idx,
          startedAt,
          chunkSeconds,
          opts,
          push
        ).catch(() => {});
        inFlight.add(job);
        job.finally(() => inFlight.delete(job));
      }
    } catch {}

    await Promise.allSettled([...inFlight]);

    // Flush remaining events
    while (queue.length) yield queue.shift()!;

    yield { type: 'done' };

    // Best-effort cleanup
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- helpers ----------

function pad(n: number): string {
  return String(n).padStart(5, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function startFfmpeg(streamUrl: string, tmpDir: string, chunkSeconds: number): ChildProcess {
  const segmentPattern = path.join(tmpDir, 'chunk-%05d.mp3');
  const args = [
    '-loglevel', 'warning',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '10',
    '-i', streamUrl,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-b:a', '64k',
    '-f', 'segment',
    '-segment_time', String(chunkSeconds),
    '-reset_timestamps', '1',
    segmentPattern,
  ];
  return spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function handleChunk(
  filePath: string,
  index: number,
  startedAt: number,
  chunkSeconds: number,
  opts: PipelineOptions,
  push: (ev: PipelineEvent) => void
): Promise<void> {
  try {
    const transcription = await transcribeAudio(filePath, opts.openaiApiKey);
    const sourceText = transcription.text.trim();

    let translatedText = sourceText;
    const targetCode = opts.targetLanguageCode;

    if (sourceText && targetCode !== (transcription.language ?? '')) {
      // Source language differs from target → translate.
      // Special-case English target: Whisper's /translations endpoint
      // would have been more efficient, but we already have the source
      // text from /transcriptions, so just route through gpt-4o-mini
      // for consistency. Cost difference is negligible.
      translatedText = await translateText(
        sourceText,
        targetCode,
        opts.openaiApiKey
      );
    }

    push({
      type: 'chunk',
      index,
      startedAt,
      durationMs: chunkSeconds * 1000,
      sourceText,
      translatedText,
      detectedLanguage: transcription.language,
    });
  } finally {
    // Always delete the chunk audio file
    fsp.unlink(filePath).catch(() => {});
  }
}

type WhisperResponse = { text: string; language?: string };

async function transcribeAudio(filePath: string, apiKey: string): Promise<WhisperResponse> {
  const buf = await fsp.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(filePath));
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json'); // gives us detected language

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Whisper ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { text: data.text ?? '', language: data.language };
}

async function translateText(
  text: string,
  targetCode: string,
  apiKey: string
): Promise<string> {
  const targetName = getLanguageName(targetCode);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            `You are a professional translator. Translate the user message into ${targetName}. ` +
            `Output ONLY the translation — no preamble, no quotes, no commentary. ` +
            `Preserve proper nouns. If the text is already in ${targetName}, return it unchanged.`,
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Translate ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? text;
}
