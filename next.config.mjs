/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    /*
     * The advance-reading routes read their manuscripts from `content/` at
     * request time. Those files are opened through a path built at runtime, so
     * Next's build-time tracing cannot infer them and would leave them out of
     * the serverless bundle. Naming them here keeps the chapters available to
     * the reader on a traced deployment; it affects no other route.
     */
    outputFileTracingIncludes: {
      '/review/**': ['./content/**/*'],
    },
  },
};

export default nextConfig;
