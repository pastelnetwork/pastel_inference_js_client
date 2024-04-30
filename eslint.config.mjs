import globals from "globals";
import pluginJs from "@eslint/js";

export default [
  // Configuration for JavaScript files
  {
    files: ["**/*.js"], // Applies to all JavaScript files
    parserOptions: {
      // Correct from `languageOptions` to `parserOptions`
      sourceType: "commonjs", // Specifies CommonJS modules
    },
    env: {
      node: true, // Ensure Node.js environment is enabled
    },
    globals: { ...globals.node }, // Adds Node.js globals
    rules: {
      // Customize the `no-unused-vars` rule
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Configuration for handling global variables in a browser context
  {
    parserOptions: {
      sourceType: "module",
    },
    env: {
      browser: true, // Explicitly set browser environment if needed
    },
    globals: globals.browser,
  },
  pluginJs.configs.recommended,
  // Your custom rule modifications can also go here
  {
    rules: {
      // ... other rules
    },
  },
];
