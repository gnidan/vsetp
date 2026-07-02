/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/vsetp/",
  plugins: [react()],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
