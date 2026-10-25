import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["chart/bench/**/*.perf.ts"],
        environment: "node",
        silent: false
    }
});
