import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gateway = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            // use library source for hot reload, hosts install the built package
            "hydromancer-charts": fileURLToPath(new URL("../chart/src/index.ts", import.meta.url))
        }
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            "/api/hydromancer": { target: gateway, ws: true }
        }
    },
    preview: {
        proxy: {
            "/api/hydromancer": { target: gateway, ws: true }
        }
    }
});
