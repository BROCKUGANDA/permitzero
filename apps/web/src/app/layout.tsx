import type { Metadata } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'PermitZero — Authority console',
  description: 'Authority before action. Review agent actions and watch enforcement health.',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    // The console ships in its signal-room theme. The light "dossier" palette
    // remains available as a class for print and daylight work, but the
    // default is deliberate rather than device-dependent.
    <html lang="en" className="dark">
      <head>
        <style>
          {
            ':root{--font-sans:"Inter Variable",ui-sans-serif,system-ui,sans-serif;--font-mono:"JetBrains Mono Variable",ui-monospace,monospace}'
          }
        </style>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
