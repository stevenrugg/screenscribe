export type TranscriptChunk = {
  index: number;
  startedAt: number; // ms from session start
  durationMs: number;
  sourceText: string;
  translatedText: string;
  detectedLanguage?: string;
};

export function formatSrt(chunks: TranscriptChunk[], useTranslated: boolean = true): string {
  return chunks
    .filter((c) => (useTranslated ? c.translatedText : c.sourceText).trim().length > 0)
    .map((c, i) => {
      const start = msToSrtTime(c.startedAt);
      const end = msToSrtTime(c.startedAt + c.durationMs);
      const text = (useTranslated ? c.translatedText : c.sourceText).trim();
      // SRT cue numbers are 1-indexed and contiguous
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

export function formatTxt(
  chunks: TranscriptChunk[],
  meta: { streamUrl: string; targetLang: string; startedAt: Date }
): string {
  const header = [
    '# StreamScribe Transcript',
    `# Stream:   ${meta.streamUrl}`,
    `# Target:   ${meta.targetLang}`,
    `# Started:  ${meta.startedAt.toISOString()}`,
    '',
    '',
  ].join('\n');

  const body = chunks
    .map((c) => {
      const stamp = msToClock(c.startedAt);
      const lines = [`[${stamp}] (chunk ${String(c.index).padStart(5, '0')})`];
      if (c.translatedText) lines.push(c.translatedText.trim());
      if (c.sourceText && c.sourceText.trim() !== c.translatedText.trim()) {
        lines.push(`  └ source (${c.detectedLanguage ?? '?'}): ${c.sourceText.trim()}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return header + body + '\n';
}

function msToSrtTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const millis = Math.max(0, ms % 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return (
    `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},` +
    pad(Math.floor(millis), 3)
  );
}

function msToClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
