// src/genex.config.ts — written by `genex init`. DO NOT hardcode URLs here.
//
// Values come from Vite env:
//   .env                    -> VITE_GENEX_SLUG (this game's identity; committed)
//   .env.development.local  -> local-stack URL overrides (dev mode ONLY — a
//                              production build always uses the defaults below;
//                              gitignored via *.local, never committed)
export const GENEX = {
  slug: import.meta.env.VITE_GENEX_SLUG as string,
  apiUrl: (import.meta.env.VITE_GENEX_API_URL as string | undefined) ?? "https://demo-api.glotech.world",
  colyseusUrl: (import.meta.env.VITE_GENEX_COLYSEUS_URL as string | undefined) ?? "wss://demo-colyseus.glotech.world",
  dashboardOrigins: ((import.meta.env.VITE_GENEX_DASHBOARD_ORIGINS as string | undefined) ?? "https://demo-web.glotech.world").split(","),
} as const;
