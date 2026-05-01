/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/app',
        destination: '/app.html',
      },
      {
        source: '/app/learning',
        destination: '/app/learning.html',
      },
    ];
  },
};

export default nextConfig;
