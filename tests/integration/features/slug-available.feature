Feature: GET /api/public/slug-available (FHS-27)
  Real Postgres on :5433 — verifies the route reads tenants.slug
  uniqueness directly. No auth required (slug list is a public fact
  about the DNS namespace).

  Background:
    Given the test Postgres has a clean tenants table

  Scenario: Free slug returns available=true with no suggestions
    When I GET /api/public/slug-available with slug "freshfamily"
    Then the response status is 200
    And the response body has available=true
    And the suggestions list is empty

  Scenario: Taken slug returns available=false with three suggestions
    Given a tenant exists with slug "khan"
    When I GET /api/public/slug-available with slug "khan"
    Then the response status is 200
    And the response body has available=false
    And the suggestions list contains "khan42"
