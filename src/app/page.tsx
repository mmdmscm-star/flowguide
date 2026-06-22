import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-5 text-center">
      <h1 className="text-3xl font-bold text-foreground mb-3">FlowGuide</h1>
      <p className="text-base text-muted max-w-sm mb-8">
        Living client packets for professionals.
      </p>
      <div className="flex flex-col gap-3 items-center">
        <Link
          href="/new"
          className="inline-flex items-center gap-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover px-6 py-3 rounded-lg transition-colors"
        >
          Create Packet
        </Link>
        <Link
          href="/dashboard"
          className="text-sm font-medium text-accent hover:text-accent-hover transition-colors"
        >
          Dashboard
        </Link>
        <Link
          href="/p/demo"
          className="text-sm text-muted hover:text-foreground transition-colors mt-2"
        >
          View Demo Packet
        </Link>
      </div>
    </main>
  );
}
