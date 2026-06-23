Feature: Kid read-only rewards

  A logged-in kid sees the family rewards with their own star balance (FHS-374).
  Redemption is parent-approved in FHS-376 — the kid POST /redeem endpoint was
  removed. Real kid token against real Postgres.

  Background:
    Given a kid "Iman" with 8 saved stars, a reward "Ice Cream" (5 stars), and "Big Prize" (100 stars)

  Scenario: a kid sees the rewards with their balance
    When the kid GETs /api/kid/rewards
    Then the kid rewards response status is 200
    And the kid rewards include "Ice Cream"
    And the kid sticker balance is 8
