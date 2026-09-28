import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  // In environments where an upstream proxy (like Nginx) listens on NGINX_PORT and routes to DEFAULT_APP_PORT,
  // the app must bind to DEFAULT_APP_PORT (typically 3000). Otherwise in direct Cloud Run deployments,
  // it must bind to PORT (typically 8080) with fallback to 3000.
  const port = process.env.NGINX_PORT
    ? (process.env.DEFAULT_APP_PORT ? parseInt(process.env.DEFAULT_APP_PORT, 10) : 3000)
    : (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true as const,
    },
  };
});
