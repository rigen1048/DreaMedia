import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const backendTarget = process.env.DREAMEDIA_API_TARGET || env.DREAMEDIA_API_TARGET || "http://127.0.0.1:8000";
  const backendProxy: ProxyOptions = {
    target: backendTarget,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyRes", (response, request) => {
        const host = request.headers.host ?? "";
        const isPublicPreview = /\.(?:manuspre\.computer|manus\.computer|manus-asia\.computer|manusvm\.computer|manuscomputer\.ai)$/i.test(host);
        const cookies = response.headers["set-cookie"];
        if (!isPublicPreview || !cookies) return;
        response.headers["set-cookie"] = cookies.map((cookie) => `${cookie.replace(/;\s*SameSite=[^;]+/i, "")}; SameSite=None; Secure`);
      });
    },
  };
  return {
    plugins: [react()],
    resolve: { alias: { "@": path.resolve(projectRoot, "client/src") } },
    envDir: projectRoot,
    root: path.resolve(projectRoot, "client"),
    publicDir: path.resolve(projectRoot, "client/public"),
    build: { outDir: path.resolve(projectRoot, "dist/public"), emptyOutDir: true },
    server: {
      host: true,
      allowedHosts: [".manuspre.computer", ".manus.computer", ".manus-asia.computer", ".manuscomputer.ai", ".manusvm.computer", "localhost", "127.0.0.1"],
      proxy: Object.fromEntries(["/auth", "/notifications", "/admin", "/yt", "/ani", "/graphql", "/health"].map((prefix) => [prefix, backendProxy])),
    },
  };
});
