/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Enable streaming responses and longer timeouts on serverless if needed
  experimental: {
    // Increase server-action body limit not needed; we POST small JSON
  },
};

module.exports = nextConfig;
