export default function Contact() {
  return (
    <footer id="contact" className="py-24 sm:py-32 border-t border-slate-800/50">
      <div className="max-w-3xl mx-auto px-6 text-center">
        {/* CTA */}
        <div className="animate-on-scroll mb-10">
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-50 mb-4">
            Let&apos;s Talk
          </h2>
          <p className="text-slate-400 text-base sm:text-lg">
            Want to build something together? I&apos;m always interested in new
            projects and collaborations.
          </p>
        </div>

        {/* Contact links */}
        <div className="animate-on-scroll stagger-1 flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
          <a
            href="mailto:mike@mikeramseyjr.com"
            className="group inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-all duration-200 hover:shadow-lg hover:shadow-indigo-500/25"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            mike@mikeramseyjr.com
          </a>

          <a
            href="https://github.com/balandari"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-slate-700 hover:border-indigo-500/50 text-slate-300 hover:text-indigo-300 font-medium transition-all duration-200"
          >
            <svg
              className="w-4 h-4"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>

        {/* Footer bottom */}
        <div className="animate-on-scroll stagger-2 pt-8 border-t border-slate-800/50">
          <p className="text-sm text-slate-500">
            &copy; 2026 Mike Ramsey Jr. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
