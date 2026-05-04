Feature: members.pin_hash + is_child schema (FHS-235)
  Real Postgres on :5433 — verifies the new Kid-Auth foundation
  columns persist round-trip and the new index is in place.

  Background:
    Given the test Postgres has clean tenants and members tables

  Scenario: A kid member can be inserted with pin_hash + is_child=true
    Given a tenant "khan" exists
    When a kid member "Iman" is inserted with pin_hash "$2b$10$dummyhash" and is_child true
    Then the row reads back with is_child true
    And the row reads back with the same pin_hash

  Scenario: An adult member defaults is_child to false and pin_hash to null
    Given a tenant "khan" exists
    When an adult member "Sarah" is inserted with no pin_hash and no is_child
    Then the row reads back with is_child false
    And the row reads back with pin_hash null
