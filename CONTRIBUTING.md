# Contributing to Tracework

Thank you for considering contributing! Tracework is an open‑source local‑first workspace for research and project work.

## Development setup

```bash
# 1. Clone the repo
git clone https://github.com/Meetmendapara09/Tracework.git
cd Tracework

# 2. Install dependencies
npm ci

# 3. Run the checks and tests
npm run check   # syntax + domain + UI tests
npm test        # run only the test suite
```

## Adding a new feature

1. **Discuss** the idea first – open an issue or discussion so maintainers can give feedback.
2. **Fork** the repository and create a branch from `main`.
3. **Implement** the feature following the existing patterns:
   - Use the `zod` schema for validation (see `src/core.js`).
   - Keep persistence atomic (temp file + rename, see `src/core.js` `createStore`).
   - Add unit tests in `test/` using Node's built‑in test runner.
   - Update `docs/architecture.md` if the data model changes.
   - Update `docs/api.md` if the HTTP API changes.
   - Update `public/app.js` and `public/index.html` for the UI.
4. **Run the full check** locally before pushing:
   ```bash
   npm run check
   ```
5. **Submit a pull request** targeting `main`. The PR must:
   - Pass all existing tests.
   - Not break any existing functionality.
   - Include updated documentation (architecture, API, or UI as appropriate).
   - Follow the MIT license and code of conduct.

## Reporting issues

- Use the [issue tracker](https://github.com/Meetmendapara09/Tracework/issues).
- Include a clear title, reproduction steps (if a bug), and your environment (OS, Node version, Docker if applicable).
- Labels: `bug`, `enhancement`, `question`, `good first issue`.

## Pull request process

1. Ensure `npm run check` passes.
2. Fill the PR template (if one exists) or describe the change, motivation, and any testing performed.
3. Address any maintainer feedback promptly.
4. Once approved, a maintainer will merge the PR.

## Code of conduct

This project is governed by the [MIT license](LICENSE). Please maintain a respectful and inclusive atmosphere.