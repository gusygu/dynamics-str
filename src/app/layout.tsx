// Root layout: the only place where global CSS is imported
import "./globals.css";

export const metadata = {
  title: "CryptoPi",
  description: "CryptoPi · strategy aux",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900 antialiased">
        {children}
      </body>
    </html>
  );
}
