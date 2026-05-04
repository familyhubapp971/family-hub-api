Feature: GET / POST / PATCH / DELETE /api/tasks (FHS-233)
  Real Postgres on :5433 — verifies the per-member private to-do
  list. The defining contract: a member only ever sees / mutates
  their OWN tasks, even if another tenant member's task id is
  guessed.

  Background:
    Given the test Postgres has clean tenants, members, tasks, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: GET returns only the caller's tasks (not other members')
    Given the caller has a task "Buy milk" due "2026-05-10" in tenant "khan"
    And the "khan" tenant has another adult "Bilal" with a task "Renew passport"
    When the caller GETs /api/tasks for tenant "khan"
    Then the GET response status is 200
    And the response includes 1 tasks
    And the first task title is "Buy milk"

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

  Scenario: Tenant isolation — another tenant's tasks never appear
    Given a second tenant "smith" exists with the caller as an admin member
    And the caller has a task "Smith stuff" due "2026-05-08" in tenant "smith"
    And separately the caller has a task "Khan stuff" due "2026-05-08" in tenant "khan"
    When the caller GETs /api/tasks for tenant "khan"
    Then the GET response status is 200
    And the response includes 1 tasks
    And the first task title is "Khan stuff"
