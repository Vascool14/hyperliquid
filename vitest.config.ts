import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["chart/test/**/*.test.ts", "gateway/test/**/*.test.ts"],
        environment: "node"
    }
});
