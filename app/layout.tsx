import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Watch Notes — Music in a new dimension',
  icons: { icon: '/favicon.svg' },
  description:
    'Turn MIDI files into cinematic 3D scores. Shape your scene, follow the music, and export a video.',
  metadataBase: new URL(process.env.APP_ORIGIN || 'http://localhost:3002'),
  openGraph: {
    title: 'Watch Notes',
    description: 'Music in a new dimension.',
    images: [{ url: '/og.png', width: 1730, height: 909 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Watch Notes',
    description: 'Music in a new dimension.',
    images: ['/og.png'],
  },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
