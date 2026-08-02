/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Never emit 308 trailing-slash redirects — browsers cache them permanently,
  // and stacked/poisoned URLs turned those cached 308s into redirect loops.
  // Our middleware handles path normalisation with a non-cacheable 307 instead.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
