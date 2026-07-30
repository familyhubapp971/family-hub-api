Feature: Parent-managed reward shop (FHS-483)
  Real Postgres on :5433 — verifies create/update/archive of the reward
  catalogue, admin-only enforcement, and tenant isolation between families.

  Background:
    Given the test Postgres has clean rewards-admin tables
    And a users mirror row exists for the rewards-admin test caller
    And a rewards-admin tenant "khans" exists with the caller as an admin member

  Scenario: An admin creates a reward
    When the caller creates a reward "Movie night" costing 20 stickers for tenant "khans"
    Then the create-reward response status is 201
    And the create-reward response reward name is "Movie night"
    And the create-reward response sticker cost is 20

  Scenario: A non-admin adult is rejected on create
    Given the "khans" tenant has an adult member "Aunt Rose"
    When an adult caller tries to create a reward for tenant "khans"
    Then the create-reward adult response status is 403

  Scenario: An admin partially updates a reward
    Given the caller creates a reward "Ice cream" costing 5 stickers for tenant "khans"
    When the caller updates the reward's sticker cost to 8
    Then the update-reward response status is 200
    And the update-reward response sticker cost is 8
    And the update-reward response reward name is "Ice cream"

  Scenario: Update returns 404 for a reward id that does not exist
    When the caller updates an unknown reward id
    Then the update-reward response status is 404

  Scenario: A non-admin adult is rejected on update
    Given the "khans" tenant has an adult member "Aunt Rose"
    And the caller creates a reward "Sleepover" costing 15 stickers for tenant "khans"
    When an adult caller tries to update the reward's sticker cost to 1
    Then the update-reward adult response status is 403

  Scenario: An admin archives (soft-deletes) a reward
    Given the caller creates a reward "Extra screen time" costing 10 stickers for tenant "khans"
    When the caller deletes the reward
    Then the delete-reward response status is 204
    And the reward no longer appears in the family rewards list for tenant "khans"
    And the reward row still exists in the database with archived_at set

  Scenario: Deleting an already-archived reward returns 404
    Given the caller creates a reward "Sleepover party" costing 12 stickers for tenant "khans"
    And the caller deletes the reward
    When the caller deletes the reward again
    Then the delete-reward response status is 404

  Scenario: A non-admin adult is rejected on delete
    Given the "khans" tenant has an adult member "Aunt Rose"
    And the caller creates a reward "Bike ride" costing 6 stickers for tenant "khans"
    When an adult caller tries to delete the reward
    Then the delete-reward adult response status is 403

  Scenario: Tenant isolation — another family cannot edit or delete this family's reward
    Given a second rewards-admin tenant "smiths" exists with a different admin caller "Priya"
    And the caller creates a reward "Family trip" costing 50 stickers for tenant "khans"
    When caller "Priya" tries to update the "khans" reward's sticker cost to 1 from tenant "smiths"
    Then the cross-tenant update response status is 404
    When caller "Priya" tries to delete the "khans" reward from tenant "smiths"
    Then the cross-tenant delete response status is 404
    And the "khans" reward "Family trip" still has sticker cost 50
    And the "smiths" family rewards list does not include "Family trip"
