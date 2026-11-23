import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import path from 'path';

const require = createRequire(import.meta.url);
const { vendureDashboardPlugin } = require('@vendure/dashboard/vite') as typeof import('@vendure/dashboard/vite');

export default defineConfig(({ mode }) => {
  // Load .env (no prefix filter) so the dashboard's API target can differ
  // per environment. Unset = 'auto': the browser calls the API on the same
  // origin it loaded the dashboard from (production builds have no .env, so a
  // fixed fallback like http://localhost gets baked in and breaks every user).
  const env = loadEnv(mode, __dirname, '');
  const apiHost = env.DASHBOARD_API_HOST || 'auto';
  const apiPort = Number(env.DASHBOARD_API_PORT) || 'auto';
  return {
  base: '/dashboard',

  server: {
    host: true, // listen on 0.0.0.0 so nginx can reach it
    // Hostnames only (no scheme). A leading dot allows every subdomain —
    // '.ngrok-free.app' covers the rotating ngrok tunnel URLs used in dev.
    allowedHosts: ['kaaikani.co.in', 'test.avsecomhub.com', '.ngrok-free.app'],
    hmr: {
      host: env.DASHBOARD_PUBLIC_HOST || 'kaaikani.co.in',
      protocol: 'wss',
      clientPort: 443,
    },
  },

  build: {
    outDir: path.join(__dirname, 'dist/dashboard'),
  },

  plugins: [
    vendureDashboardPlugin({
      vendureConfigPath: pathToFileURL(path.join(__dirname, 'src/vendure-config.ts')),
      api: { host: apiHost, port: apiPort },
      gqlOutputPath: path.join(__dirname, 'src/gql'),
    }),
  ],

  resolve: {
    alias: {
      '@/gql': path.join(__dirname, 'src/gql/graphql.ts'),
    },
  },
  };
});