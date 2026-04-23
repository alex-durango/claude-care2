import "./globals.css";

export const metadata = {
  title: "CLAUDECARE · ai mood tracker",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script src="/palette-init.js" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=VT323&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="flex min-h-screen items-center justify-center p-6">
        {children}
      </body>
    </html>
  );
}
