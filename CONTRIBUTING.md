# Contributing

Small, focused changes are easiest to review.

1. Fork the repository and create a feature branch.
2. Run `corepack enable && pnpm install --frozen-lockfile`.
3. Add or update tests for behavior changes.
4. Run `pnpm test` and `pnpm build`.
5. Open a pull request describing the user-visible outcome.

Never commit credentials, authentication tokens, real room transcripts, or
private product source from the macOS app, website, or hosted backend.

