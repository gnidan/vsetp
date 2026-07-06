/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/vsetp/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // the entire point of offline support is the 10.9MB OpenCV
      // artifact; Workbox's 2MiB default silently excludes it
      workbox: {
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
      },
      includeAssets: ["vendor/opencv-4.13.0.js"],
      manifest: {
        name: "vsetp — Set table reader",
        short_name: "vsetp",
        description: "Point your camera at a Set spread; find the sets.",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#12233a",
        theme_color: "#12233a",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
