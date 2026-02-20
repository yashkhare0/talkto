export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Valid types for this project
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "chore",
        "docs",
        "test",
        "ci",
        "refactor",
        "style",
        "perf",
        "build",
        "revert",
      ],
    ],
    // Keep subject concise
    "header-max-length": [2, "always", 100],
  },
};
