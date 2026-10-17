import globals from "globals";
const rules = {
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-undef": "error",
};
export default [
  {
    files: ["src/**/*.js", "test/**/*.js", "*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node },
    rules,
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.browser },
    rules,
  },
];
