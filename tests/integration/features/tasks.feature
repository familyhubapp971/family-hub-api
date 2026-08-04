Feature: GET / POST / PATCH / DELETE /api/tasks (FHS-233, FHS-267)
  Real Postgres on :5433, verifies the shared family task board
  (ADR 0013): family-wide read, owner-scoped write. A member SEES every
  family member's tasks but can only MUTATE their own, even if another
  member's task id is guessed.

  Background:
    Given the test Postgres has clean tenants, members, tasks, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: GET returns the whole family's tasks (caller + other members)
    Given the caller has a task "Buy milk" due "2026-05-10" in tenant "khan"
    And the "khan" tenant has another adult "Bilal" with a task "Renew passport"
    When the caller GETs /api/tasks for tenant "khan"
    Then the GET response status is 200
    And the response includes 2 tasks
    And the response contains tasks titled "Buy milk" and "Renew passport"
    And the response callerMemberId is the caller's member

  Scenario: POST creates a task assigned to the caller; GET returns it
    When the caller POSTs a task "Call doctor" due "2026-05-08" in tenant "khan"
    Then the POST response status is 201
    And re-fetching /api/tasks for tenant "khan" lists 1 tasks

  Scenario: PATCH cannot toggle another member's task
    Given the "khan" tenant has another adult "Bilal" with a task "Renew passport"
    When the caller marks Bilal's task done in tenant "khan"
    Then the PATCH response status is 404
    And Bilal's task is still not done in the database

  Scenario: DELETE cannot remove another member's task
    Given the "khan" tenant has another adult "Bilal" with a task "Renew passport"
    When the caller deletes Bilal's task in tenant "khan"
    Then the DELETE response status is 404
    And Bilal's task still exists in the database

  Scenario: A task owner can edit their own task (FHS-310)
    Given the caller has a task "Buy milk" due "2026-05-10" in tenant "khan"
    When the caller PUTs the "Buy milk" task title to "Buy oat milk" in tenant "khan"
    Then the PUT task response status is 200
    And re-fetching /api/tasks for tenant "khan" shows task title "Buy oat milk"

  Scenario: Editing another member's task returns 404 (FHS-310)
    Given the "khan" tenant has another adult "Bilal" with a task "Renew passport"
    When the caller PUTs Bilal's task title to "Sneaky edit" in tenant "khan"
    Then the PUT task response status is 404

  Scenario: Tenant isolation: another tenant's tasks never appear
    Given a second tenant "smith" exists with the caller as an admin member
    And the caller has a task "Smith stuff" due "2026-05-08" in tenant "smith"
    And separately the caller has a task "Khan stuff" due "2026-05-08" in tenant "khan"
    When the caller GETs /api/tasks for tenant "khan"
    Then the GET response status is 200
    And the response includes 1 tasks
    And the first task title is "Khan stuff"
