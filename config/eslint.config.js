import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "data/**"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: {
      camelcase: ["error", { properties: "never" }],
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "no-empty": "error",
      "no-implicit-globals": "error",
      "no-throw-literal": "error",
      "no-var": "error",
      "prefer-const": "error",
      "prefer-promise-reject-errors": "error",
    },
  },
  { files: ["public/**/*.js"], languageOptions: { globals: globals.browser } },
  { files: ["test/**/*.js"], rules: { "no-console": "off" } },
];
