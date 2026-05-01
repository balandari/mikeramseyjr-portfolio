export default function Hero() {
  return (
    <section
      id="hero"
      className="relative min-h-screen flex items-center justify-center hero-gradient"
    >
      {/* Subtle grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      <div className="relative z-10 max-w-3xl mx-auto px-6 text-center">
        {/* Small accent line */}
        <div className="animate-fade-in mb-8">
          <div className="w-12 h-0.5 bg-indigo-500 mx-auto rounded-full" />
        </div>

        {/* Name */}
        <h1 className="animate-fade-in text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight text-slate-50 mb-6">
          Mike Ramsey Jr
        </h1>

        {/* Tagline */}
        <p className="animate-fade-in-delay text-xl sm:text-2xl font-medium text-indigo-400 mb-6 tracking-wide">
          Create. Question. Refine.
        </p>

        {/* Subtitle */}
        <p className="animate-fade-in-up-delay text-base sm:text-lg text-slate-400 max-w-xl mx-auto mb-10 leading-relaxed">
          AI developer building real products at the intersection of human
          creativity and artificial intelligence.
        </p>

        {/* CTA links */}
        <div className="animate-fade-in-up-delay flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href="#projects"
            className="group inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-all duration-200 hover:shadow-lg hover:shadow-indigo-500/25"
          >
            View Projects
            <svg
              className="w-4 h-4 transition-transform duration-200 group-hover:translate-y-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </a>
          <a
            href="#contact"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-slate-700 hover:border-indigo-500/50 text-slate-300 hover:text-indigo-300 font-medium transition-all duration-200"
          >
            Get in Touch
          </a>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
        <div className="w-5 h-8 rounded-full border-2 border-slate-600 flex items-start justify-center p-1">
          <div className="w-1 h-2 rounded-full bg-slate-500" />
        </div>
      </div>
    </section>
  );
}
