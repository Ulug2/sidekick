// Lint: typescript-eslint's recommended rules, minus the ones this codebase uses on purpose
// (explicit any for untyped page DOM and site objects; empty catch blocks for best-effort calls).
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", ".test-build/", "node_modules/", "public/", "tests/", "scripts/", "src/content/"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "@typescript-eslint/no-unused-expressions": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Browser globals that are easy to call by accident when an import is missing:
      // a missing `close` import once meant window.close() (see docs/LESSONS.md 15).
      "no-restricted-globals": ["error",
        { name: "close", message: "This is window.close(). Import the helper you meant." },
        { name: "stop", message: "This is window.stop(). Import the function you meant." },
        { name: "status", message: "This is window.status. Declare or import it." },
        { name: "name", message: "This is window.name. Declare or import it." },
        { name: "open", message: "This is window.open(). Use chrome.tabs.create or import the helper." },
        { name: "event", message: "This is the deprecated window.event. Use the handler's parameter." },
        { name: "length", message: "This is window.length (the frame count)." },
        { name: "find", message: "This is window.find(). Import the helper you meant." },
        { name: "print", message: "This is window.print()." }
      ]
    }
  }
);
