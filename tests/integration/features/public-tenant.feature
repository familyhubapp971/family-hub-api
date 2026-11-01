Feature: POST /api/public/tenant (FHS-25)
  Real Postgres on :5433, verifies the route inserts a tenants row with
  a private code (FHS-715) + a members row linking the authenticated
  user, and that a person creates only one family (FHS-716).

  Background:
    Given the test Postgres has clean tenants and members tables
    And a users mirror row exists for the test user

  Scenario: Happy path: creates a family with a private code, returns 201
    When I POST to /api/public/tenant with familyName "Smith" displayName "Sam"
    Then the response status is 201
    And the response body has a tenant with a private code
    And exactly 1 row exists in tenants made by the test user
    And exactly 1 row exists in members with displayName "Sam" and role "admin"

  Scenario: Two families with the same surname both get their own code
    Given another family called "Smith" already exists
    When I POST to /api/public/tenant with familyName "Smith" displayName "Sam"
    Then the response status is 201
    And exactly 2 rows exist in tenants named "Smith"

  Scenario: One family per home: a second create returns the first family
    Given I already created a family called "Smith"
    When I POST to /api/public/tenant with familyName "Jones" displayName "Sam"
    Then the response status is 200
    And the response body is the family I already created
    And exactly 1 row exists in tenants made by the test user
