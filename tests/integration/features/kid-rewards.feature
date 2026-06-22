Feature: Kid rewards + money

  A logged-in kid sees the family rewards with their own star balance and their
  savings, and can claim a reward they can afford with their own stars — never
  going below zero (FHS-364). Real kid token against real Postgres.

  Background:
    Given a kid "Iman" with 8 saved stars, a reward "Ice Cream" (5 stars), and "Big Prize" (100 stars)

  Scenario: a kid sees the rewards with their balance
    When the kid GETs /api/kid/rewards
    Then the kid rewards response status is 200
    And the kid rewards include "Ice Cream"
    And the kid sticker balance is 8

  Scenario: a kid sees their savings
    When the kid GETs /api/kid/financial
    Then the kid financial response status is 200
    And the kid saved stars is 8

  Scenario: a kid claims an affordable reward
    When the kid redeems "Ice Cream"
    Then the redeem response status is 201
    And the redeemed balance is 3

  Scenario: a kid cannot claim a reward they can't afford
    When the kid redeems "Big Prize"
    Then the redeem response status is 409

  Scenario: a kid cannot claim a reward from another family
    When the kid redeems a reward belonging to another family
    Then the redeem response status is 404
