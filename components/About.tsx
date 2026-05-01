export default function About() {
  return (
    <section id="about" className="py-24 sm:py-32 relative">
      {/* Subtle background accent */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-indigo-500/[0.02] to-transparent" />

      <div className="relative max-w-3xl mx-auto px-6">
        {/* Section header */}
        <div className="animate-on-scroll text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-50 mb-4">
            About
          </h2>
        </div>

        {/* About text */}
        <div className="animate-on-scroll stagger-1 space-y-6">
          <p className="text-slate-300 text-base sm:text-lg leading-relaxed">
            Six months ago, I bought a $45 crypto miner from eBay and discovered
            the seller had pre-configured it to steal my earnings. Instead of
            just returning it, I decided to build my own&nbsp;&mdash; and that
            rabbit hole led me to AI-assisted development.
          </p>

          <p className="text-slate-300 text-base sm:text-lg leading-relaxed">
            Since then, I&apos;ve been building full-stack applications with AI as
            a development partner. Not generating templates or assembling
            boilerplate&nbsp;&mdash; actually building products, debugging at
            3am, and shipping things that work.
          </p>

          <p className="text-slate-300 text-base sm:text-lg leading-relaxed">
            I&apos;m not a traditional developer. I&apos;m someone who found a
            new way to create, and I haven&apos;t stopped since.
          </p>
        </div>

        {/* Accent divider */}
        <div className="animate-on-scroll stagger-2 mt-12 flex justify-center">
          <div className="w-16 h-0.5 bg-indigo-500/40 rounded-full" />
        </div>
      </div>
    </section>
  );
}
