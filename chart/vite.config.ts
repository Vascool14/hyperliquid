import { defineConfig } from "vite";

// keep dependencies external so hosts can share them, tsc emits the type declarations
export default defineConfig({
    build: {
        lib: {
            entry: "src/index.ts",
            formats: ["es"],
            fileName: "index"
        },
        sourcemap: true,
        rollupOptions: {
            external: ["lightweight-charts", "fzstd", "@msgpack/msgpack"]
        }
    }
});
