/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'export', // 🚀 Forces Next.js to output a raw, serverless static website bundle
    images: {
      unoptimized: true, // Required for static exports to compile cleanly
    }
  };
  
  export default nextConfig;
  