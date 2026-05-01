const projects = [
  {
    name: "TrovoPilot",
    url: "https://trovopilot.com",
    description:
      "AI-powered auction intelligence for resellers. Scout lots before you bid, track pricing in real time, and calculate profit margins with precision.",
    features: [
      "AI lot scouting across 15+ categories",
      "Real-time bid tracking with outbid alerts",
      "AI-powered resale valuations",
      "Offline-capable PWA with field scanning",
      "Multi-tier SaaS with freemium model",
    ],
    tech: [
      "Next.js",
      "React",
      "Tailwind CSS",
      "Supabase",
      "Google Gemini",
      "Claude AI",
    ],
    mockup: {
      bg: "from-slate-900 to-slate-800",
      accent: "bg-blue-500",
      accentText: "text-blue-400",
      title: "TrovoPilot",
      tagline: "Know What to Bid. Know Your Profit.",
      dotColors: ["bg-blue-500/80", "bg-blue-400/60", "bg-blue-300/40"],
    },
  },
  {
    name: "PulseBoard",
    url: "https://thepulseboard.io",
    secondaryUrl: "https://v2.thepulseboard.io",
    description:
      "Real-time financial dashboard tracking crypto, stocks, and precious metals with live price feeds from multiple data sources.",
    features: [
      "Live price tracking across crypto, stocks & metals",
      "Top movers and losers",
      "Portfolio tracking",
      "All-time high ticker",
      "Multi-source data aggregation",
    ],
    tech: [
      "Next.js",
      "React",
      "WebSocket",
      "CoinGecko API",
      "Coinbase",
    ],
    mockup: {
      bg: "from-slate-900 to-emerald-950/30",
      accent: "bg-emerald-500",
      accentText: "text-emerald-400",
      title: "PulseBoard",
      tagline: "Real Time Live Prices",
      dotColors: ["bg-emerald-500/80", "bg-emerald-400/60", "bg-emerald-300/40"],
    },
  },
];

function BrowserMockup({
  mockup,
}: {
  mockup: (typeof projects)[number]["mockup"];
}) {
  return (
    <div className="browser-mockup border border-slate-700/50 rounded-lg overflow-hidden">
      {/* Browser chrome bar */}
      <div className="browser-mockup-bar border-b border-slate-700/50">
        <div className={`browser-dot ${mockup.dotColors[0]}`} />
        <div className={`browser-dot ${mockup.dotColors[1]}`} />
        <div className={`browser-dot ${mockup.dotColors[2]}`} />
        <div className="ml-3 flex-1 h-5 bg-slate-800/60 rounded-md max-w-[200px]" />
      </div>

      {/* Mockup content */}
      <div
        className={`bg-gradient-to-br ${mockup.bg} p-8 sm:p-10 flex flex-col items-center justify-center min-h-[180px]`}
      >
        <div className={`w-8 h-1 ${mockup.accent} rounded-full mb-4 opacity-80`} />
        <h3 className="text-xl sm:text-2xl font-bold text-slate-100 mb-2">
          {mockup.title}
        </h3>
        <p className={`text-sm ${mockup.accentText} font-medium tracking-wide`}>
          {mockup.tagline}
        </p>
      </div>
    </div>
  );
}

export default function Projects() {
  return (
    <section id="projects" className="py-24 sm:py-32">
      <div className="max-w-6xl mx-auto px-6">
        {/* Section header */}
        <div className="animate-on-scroll text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-50 mb-4">
            What I&apos;ve Built
          </h2>
          <p className="text-slate-400 max-w-lg mx-auto">
            Full-stack products built from scratch with AI as a development
            partner.
          </p>
        </div>

        {/* Project cards */}
        <div className="grid md:grid-cols-2 gap-8">
          {projects.map((project, index) => (
            <div
              key={project.name}
              className={`animate-on-scroll stagger-${index + 1} card-glow rounded-xl border border-slate-800 bg-[#131727] overflow-hidden`}
            >
              {/* Browser mockup */}
              <BrowserMockup mockup={project.mockup} />

              {/* Card content */}
              <div className="p-6 sm:p-8">
                <h3 className="text-xl font-bold text-slate-50 mb-3">
                  {project.name}
                </h3>
                <p className="text-slate-400 text-sm leading-relaxed mb-5">
                  {project.description}
                </p>

                {/* Features list */}
                <ul className="space-y-2 mb-6">
                  {project.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-2 text-sm text-slate-300"
                    >
                      <svg
                        className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>

                {/* Tech badges */}
                <div className="flex flex-wrap gap-2 mb-6">
                  {project.tech.map((t) => (
                    <span key={t} className="tech-badge">
                      {t}
                    </span>
                  ))}
                </div>

                {/* Links */}
                <div className="flex items-center gap-4">
                  <a
                    href={project.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="arrow-link inline-flex items-center gap-1.5 text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Visit Site <span className="arrow">&rarr;</span>
                  </a>
                  {project.secondaryUrl && (
                    <a
                      href={project.secondaryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="arrow-link inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      V2 <span className="arrow">&rarr;</span>
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
