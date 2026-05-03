Feature: GET + POST /api/meals (FHS-229)
  Real Postgres on :5433 — verifies the weekly meal planner returns
  every cell, upserts via the (tenant_id, day_of_week, slot) unique
  index, deletes when name is empty, blocks non-admin/adult callers
  from writing, and never leaks rows across tenants.

  Background:
    Given the test Postgres has clean tenants, members, meal_templates, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: GET returns an empty list when nothing has been planned
    When the caller GETs /api/meals for tenant "khan"
    Then the response status is 200
    And the response lists 0 meals

  Scenario: POST upserts a meal cell, GET returns it
    When the caller POSTs a meal "Porridge" for "mon" "breakfast" in tenant "khan"
    Then the POST response status is 200
    And re-fetching /api/meals for tenant "khan" lists 1 meals
    And the response includes "Porridge" for "mon" "breakfast"

  Scenario: POST upserting the same cell replaces the previous value
    When the caller POSTs a meal "Porridge" for "mon" "breakfast" in tenant "khan"
    And the caller POSTs a meal "Pancakes" for "mon" "breakfast" in tenant "khan"
    Then re-fetching /api/meals for tenant "khan" lists 1 meals
    And the response includes "Pancakes" for "mon" "breakfast"

  Scenario: POST with empty name deletes the cell
    Given the "khan" tenant has a meal "Porridge" planned for "mon" "breakfast"
    When the caller POSTs a meal "" for "mon" "breakfast" in tenant "khan"
    Then the POST response status is 200
    And re-fetching /api/meals for tenant "khan" lists 0 meals

  Scenario: A child member cannot write to the plan
    Given the caller's role in "khan" is "child"
    When the caller POSTs a meal "Porridge" for "mon" "breakfast" in tenant "khan"
    Then the response status is 403

  Scenario: Tenant isolation — meals never leak across tenants
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a meal "Pasta" planned for "wed" "dinner"
    When the caller GETs /api/meals for tenant "khan"
    Then the response status is 200
    And the response lists 0 meals
