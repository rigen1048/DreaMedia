import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const apiPrefixes = [
  "/auth",
  "/notifications",
  "/admin",
  "/yt",
  "/ani",
  "/graphql",
  "/health",
] as const;
function createBackendProxy(target: string): ProxyOptions {
  return { target, changeOrigin: true };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const backendTarget =
    process.env.DREAMEDIA_API_TARGET ?? env.DREAMEDIA_API_TARGET ?? "http://127.0.0.1:8123";
  const proxy = createBackendProxy(backendTarget);

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(projectRoot, "src"),
      },
    },
    envDir: projectRoot,
    publicDir: path.resolve(projectRoot, "public"),
    build: {
      outDir: path.resolve(projectRoot, "dist"),
      emptyOutDir: true,
    },
    server: {
      host: true,
      allowedHosts: ["localhost", "127.0.0.1"],
      proxy: {
        ...Object.fromEntries(apiPrefixes.map((prefix) => [prefix, proxy])),
      },
    },
  };
});
