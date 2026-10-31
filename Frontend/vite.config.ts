import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
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
const previewHostSuffixes = [
  "manuspre.computer",
  "manus.computer",
  "manus-asia.computer",
  "manusvm.computer",
  "manuscomputer.ai",
] as const;

function isPublicPreview(host: string): boolean {
  return previewHostSuffixes.some((suffix) => host.toLowerCase().endsWith(suffix));
}

function createBackendProxy(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyRes", (response, request) => {
        const host = request.headers.host ?? "";
        const cookies = response.headers["set-cookie"];
        if (!isPublicPreview(host) || !cookies) return;

        response.headers["set-cookie"] = cookies.map(
          (cookie) => `${cookie.replace(/;\s*SameSite=[^;]+/i, "")}; SameSite=None; Secure`,
        );
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const backendTarget =
    process.env.DREAMEDIA_API_TARGET ?? env.DREAMEDIA_API_TARGET ?? "http://127.0.0.1:8000";
  const proxy = createBackendProxy(backendTarget);

  return {
    plugins: [react()],
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
      allowedHosts: [
        ".manuspre.computer",
        ".manus.computer",
        ".manus-asia.computer",
        ".manuscomputer.ai",
        ".manusvm.computer",
        "localhost",
        "127.0.0.1",
      ],
      proxy: Object.fromEntries(apiPrefixes.map((prefix) => [prefix, proxy])),
    },
  };
});
