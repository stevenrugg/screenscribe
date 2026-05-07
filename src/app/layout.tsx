import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'StreamScribe — Live transcripts, any stream, any language',
  description:
    'Paste a URL. We find the audio. We translate it as it plays. Download the transcript when you\'re done.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen relative">{children}</body>
    </html>
  );
}
