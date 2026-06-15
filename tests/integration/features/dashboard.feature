Feature: GET /api/dashboard/today (FHS-228)
  Real Postgres on :5433 — verifies the home-tab payload bundles
  greeting, today's date, the family roster and counts (members /
  habits / rewards), blocks non-members with 403, and never leaks
  rows across tenants.

  Background:
    Given the test Postgres has clean tenants, members, habits, rewards, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: Returns greeting, members, and counts for the caller's tenant
    Given the "khan" tenant has a child member "Iman" with no linked user
    And the "khan" tenant has 2 starter habits and 1 starter rewards
    And the "khan" tenant has 1 archived habit and 1 archived reward
    When the caller GETs /api/dashboard/today for tenant "khan"
    Then the response status is 200
    And the response includes today's date in YYYY-MM-DD form
    And the response counts are:
      | label   | n |
      | members | 2 |
      | habits  | 2 |
      | rewards | 1 |
    And the response lists 2 members
    And the member named "Iman" appears in the response

  Scenario: Today screen surfaces per-member stats, goals, and recent activity
    Given the "khan" tenant has 2 starter habits and 0 starter rewards
    And the caller completed both "khan" habits in the current week
    And the caller has 1 pending task and 1 task completed today in "khan"
    And the "khan" tenant has a savings goal "Hajj fund" with a 300 deposit and a 50 withdrawal
    And the "khan" tenant has a meal planned for today
    And the "khan" tenant has a member meal in the same slot today
    And the "khan" tenant has a recent activity entry "completed a habit"
    When the caller GETs /api/dashboard/today for tenant "khan"
    Then the response status is 200
    And the caller's member stats show 0 of 0 habits done and 1 task pending
    And the response snapshot counts include tasksDoneToday 1 and mealsPlanned 1
    And the response goal "Hajj fund" shows progress 250 and target 5000
    And the response recent activity includes "completed a habit"

  Scenario: FHS-306 — My World sticker earns habitsDone and mw_week_action appears in activity
    Given the "khan" tenant has a child member "Iman" with no linked user
    And "Iman" has an open mw_week with 1 sticker placed in "khan"
    And the "khan" tenant has a mw_week_action "claim" for "Iman" with reward "Ice cream"
    When the caller GETs /api/dashboard/today for tenant "khan"
    Then the response status is 200
    And the member "Iman" shows habitsDone 1 and starBalance at least 1
    And the recent activity includes a "claimed Ice cream" entry for "Iman"

  Scenario: A non-member of the tenant gets 403
    Given a second tenant "smith" exists with no caller membership
    When the caller GETs /api/dashboard/today for tenant "smith"
    Then the response status is 403

  Scenario: Tenant isolation — counts and members never leak across tenants
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a child member "Zaid" with no linked user
    And the "smith" tenant has 4 starter habits and 2 starter rewards
    And the "smith" tenant has a savings goal "Smith fund" with a 100 deposit
    And the "smith" tenant has a recent activity entry "smith event"
    And the "smith" tenant has 1 task completed today by "Zaid"
    When the caller GETs /api/dashboard/today for tenant "khan"
    Then the response status is 200
    And the response counts are:
      | label   | n |
      | members | 1 |
      | habits  | 0 |
      | rewards | 0 |
    And no member named "Zaid" is in the response
    And the response goals are empty
    And the response recent activity is empty
    And the response snapshot counts include tasksDoneToday 0 and mealsPlanned 0
