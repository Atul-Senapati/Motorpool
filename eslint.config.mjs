import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    /**
     * The render loop mutates by design.
     *
     * `react-hooks/immutability` exists to keep components safe for the React
     * Compiler to memoise, and forbids writing to anything a hook returned. A
     * real-time scene is the case it does not model: at 60 fps the vehicle
     * telemetry, keyboard input, per-wheel state and the particle/skid-mark
     * buffers must be mutated in place, because allocating fresh objects and
     * arrays every frame is precisely the thing that destroys frame times — and
     * routing any of it through React state would re-render the tree 60 times a
     * second.
     *
     * These files therefore mutate long-lived typed arrays, scratch vectors and
     * input refs inside `useFrame` deliberately. That is the documented React
     * Three Fiber pattern, so the rule is switched off for the scene code only;
     * it stays on everywhere else, including all UI.
     */
    files: [
      "src/components/racing/**/*.{ts,tsx}",
      "src/hooks/**/*.ts",
      "src/physics/**/*.ts",
    ],
    rules: {
      "react-hooks/immutability": "off",
    },
  },
]);

export default eslintConfig;
