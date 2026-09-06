import type { Metadata } from "next";
import { Geist, Newsreader, Source_Sans_3, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// THE FACES A TREATMENT MAY ASK FOR.
//
// Declared here because next/font is a build-time loader: it self-hosts the
// files, emits one @font-face per family and hands back a class that sets a CSS
// variable. A treatment names the VARIABLE, never the family, so the treatment
// layer stays free of loader mechanics and this file stays the only place a
// font is fetched.
//
// preload:false ON EVERYTHING BUT GEIST, deliberately. Geist is what every
// Sendset wears today, so it earns the <link rel=preload>. The other three are
// worn only by a treatment nobody has selected yet, and preloading a face no
// page uses spends a recipient's bandwidth on a look they were not sent.
// display:"swap" so a face that has not arrived shows the fallback stack in the
// treatment rather than invisible text.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

// The description is what a professional reads in a link preview when the URL
// is pasted into a message or an email — which, for now, is how most people
// will meet FlowGuide. "Living client packets for professionals" was internal
// vocabulary: it said nothing a stranger could act on, and "packet" is not the
// word a professional uses.
//
// The card image is ONE static asset in /public. There is no per-page OG
// generation and none is wanted.
//
// Recipient pages set their own metadata and their own `robots: noindex` —
// /p/[slug] and its print route carry a client's name and a personal note, and
// they override everything here deliberately.
export const metadata: Metadata = {
  metadataBase: new URL("https://sendset.io"),
  title: "Sendset",
  description:
    "Turn the notes you already have into one clear guide your client can use — and send it by link, email, message, or print.",
  openGraph: {
    title: "Sendset",
    description:
      "Turn the notes you already have into one clear guide your client can use — and send it by link, email, message, or print.",
    url: "/",
    siteName: "Sendset",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Sendset" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sendset",
    description:
      "Turn the notes you already have into one clear guide your client can use — and send it by link, email, message, or print.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${newsreader.variable} ${sourceSans.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
