# family-hub-api

The Family Hub server: the API, the database and its changes, sign-in
emails, and the common rules the web site and phone app install.

Part of the three-repo split in
[ADR 0021](https://github.com/familyhubapp971/family-hub-web/blob/staging/documents/decisions/0021-three-repo-split.md)
([FHS-686](https://qualicion2.atlassian.net/browse/FHS-686)). The other
two are `family-hub-web` and `family-hub-app`.

## Layout

| Folder                 | What it holds                                                    |
| ---------------------- | ---------------------------------------------------------------- |
| `apps/api/`            | The server code, database changes, endpoint docs, sign-in emails |
| `packages/shared/`     | The common rules, published for web and mobile                   |
| `packages/test-utils/` | Helpers the tests share                                          |
| `tests/unit/`          | Fast tests with no database                                      |
| `tests/integration/`   | Tests against a real database                                    |
| `tests/performance/`   | Speed tests                                                      |
| `scripts/`             | Sign-in setup, data export and seeding tools                     |

The grouping by product area (members, calendar, meals and so on) lands
in the next change; until then the layout matches the original repo.

## Run it

```bash
pnpm install
pnpm dev:up            # local database
pnpm -F @familyhub/api dev
pnpm test              # unit tests
pnpm test:integration  # needs Docker
```

## Deploys

| Branch    | Deploys to                                    |
| --------- | --------------------------------------------- |
| `staging` | staging server, fh-api-staging.up.railway.app |
| `main`    | production, once FHS-690 moves it here        |
