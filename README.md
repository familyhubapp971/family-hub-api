# family-hub-api

The Family Hub server: the API, the database and its changes, sign-in
emails, and the common rules the web site and phone app install.

Part of the three-repo split in
[ADR 0021](https://github.com/familyhubapp971/family-hub-web/blob/staging/documents/decisions/0021-three-repo-split.md)
([FHS-686](https://qualicion2.atlassian.net/browse/FHS-686)). The other
two are `family-hub-web` and `family-hub-app`.

## Layout

| Folder             | What it holds                                                         |
| ------------------ | --------------------------------------------------------------------- |
| `src/areas/`       | One folder per product area: family, calendar, meals, tasks, learn... |
| `src/security/`    | Sign-in checks, per-family privacy walls, rate limits                 |
| `src/database/`    | How data is stored, plus every past database change (`migrations/`)   |
| `src/services/`    | Email, AI, logging and error reporting                                |
| `src/api-docs/`    | Builds the endpoint list from the code                                |
| `shared-rules/`    | The common rules, published for the web site and phone app            |
| `email-templates/` | The branded sign-in emails                                            |
| `api-docs/`        | The generated endpoint list and Postman test set                      |
| `scripts/`         | Start-up, sign-in setup, data export and seeding tools                |
| `tests/`           | Unit, integration (real database) and speed tests, plus `helpers/`    |

## Run it

```bash
pnpm install
pnpm dev:up            # local database
pnpm dev
pnpm test              # unit tests
pnpm test:integration  # needs Docker
```

## Deploys

| Branch    | Deploys to                                    |
| --------- | --------------------------------------------- |
| `staging` | staging server, fh-api-staging.up.railway.app |
| `main`    | production, once FHS-690 moves it here        |
