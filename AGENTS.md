# Repository Guidelines

## Project Structure & Module Organization

This directory currently contains no application code, tests, assets, or Git metadata. No language or framework has been selected. Keep this guide aligned with the actual project as files are added.

For initial implementation, prefer `src/` for source code, `tests/` for automated tests, `assets/` for static resources, and `docs/` for supporting documentation. Create directories only when needed. Add a root `README.md` describing the project's purpose and setup.

## Build, Test, and Development Commands

No build, development, or test commands are configured yet. Do not assume commands such as `npm test` or `make build` are available.

When introducing tooling, document exact installation, local execution, build, and test commands in `README.md`, then update this guide. Use `rg --files --hidden -g '!.git'` to inspect project files. After Git is initialized, run `git diff --check` before submitting changes to catch whitespace errors.

## Coding Style & Naming Conventions

Follow language-standard conventions once a stack is chosen. Use consistent indentation within each file, descriptive identifiers, and filenames that reflect their contents. Avoid mixing unrelated changes in one contribution.

Configure a formatter and linter appropriate to the chosen language, commit their configuration, and document how to run them. Never commit generated dependencies or build outputs.

## Testing Guidelines

No testing framework or coverage threshold exists yet. Add automated tests alongside new behavior and regression tests for bug fixes. Keep test organization parallel to source modules and follow the selected framework's discovery conventions. Document the test command before relying on it in reviews or automation.

## Commit & Pull Request Guidelines

No Git history is available to establish existing conventions. Use short, imperative commit subjects, such as `Add project setup instructions`.

Pull requests should explain the change, its purpose, and validation performed. Link related issues when available; include screenshots for visible interface changes. Explicitly state when tests could not be run and why.

## Security & Configuration

Keep secrets and local configuration out of version control. When environment variables are introduced, provide an `.env.example` containing placeholders and ignore local `.env` files.
