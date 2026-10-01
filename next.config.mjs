/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // proxy.ts buffers request bodies and truncates them at 10MB by default,
    // which corrupts base64 media uploads. Match nginx's client_max_body_size.
    proxyClientMaxBodySize: "25mb",
  },
};

export default nextConfig;
