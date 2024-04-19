import globals from "globals";
import pluginJs from "@eslint/js";

export default [
  // Configuration for JavaScript files
  {
    files: ["**/*.js"], // Applies to all JavaScript files
    languageOptions: {
      sourceType: "commonjs", // Specifies CommonJS modules
      globals: { ...globals.node }, // Adds Node.js globals
    },
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
    languageOptions: { globals: globals.browser },
  },
  pluginJs.configs.recommended,
  // Your custom rule modifications can also go here
  {
    rules: {
      // ... other rules
    },
  },
];
