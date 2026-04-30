Feature: API health endpoint
  /health is the public, no-auth route used by Railway's internal probe
  and any external uptime monitor. The integration tier verifies the
  contract end-to-end against a real Hono app + real Postgres.

  Scenario: GET /health returns the standard envelope
    When I GET /health
    Then the response status is 200
    And the body field "status" equals "ok"
    And the body field "version" is a string
    And the body field "uptime" is a non-negative number

  Scenario: Test Postgres is reachable on port 5433
    When I run "SELECT 1 AS one" against the test DB
    Then I get back one row with one equal to 1

  Scenario: Unknown routes still require auth — 401, not 404
    When I GET /this-route-does-not-exist
    Then the response status is 401
    And the body equals { "error": "unauthorized" }

  Scenario: /health survives a concurrent burst — 50 calls all 200
    When I GET /health 50 times concurrently
    Then every response status is 200
    And the test Postgres is still reachable
