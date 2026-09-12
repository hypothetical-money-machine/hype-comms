import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.claude/**",
      "**/.clog/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/out/**",
      "**/release/**",
      "**/worktrees/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["apps/desktop/src/main/**/*.ts", "apps/desktop/src/preload/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='handle']",
          message:
            "Declare the invoke contract and register a complete handler map through registerDesktopInvokes.",
        },
        {
          selector:
            "CallExpression[callee.object.name='ipcRenderer'][callee.property.name='invoke']",
          message:
            "Invoke through createDesktopInvoker so request and response validation use the shared contract.",
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
);
