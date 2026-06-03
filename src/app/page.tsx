import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-5 text-center">
      <h1 className="text-3xl font-bold text-foreground mb-3">FlowGuide</h1>
      <p className="text-base text-muted max-w-sm mb-8">
        Living client packets for professionals.
      </p>
      <Link
        href="/p/demo"
        className="inline-flex items-center gap-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover px-6 py-3 rounded-lg transition-colors"
      >
        View Demo Packet
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </Link>
    </main>
  );
}
