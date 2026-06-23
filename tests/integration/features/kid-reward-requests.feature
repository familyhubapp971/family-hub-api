Feature: Kid reward redemption requests (FHS-376)

  A kid asks to redeem a reward; an admin parent approves or declines. Approval
  deducts the cost from the kid's SAVINGS only. Non-admins cannot decide.

  Background:
    Given a family with an admin parent, a non-admin adult, a kid "Iman" with 10 saved stars, and a reward "Ice Cream" (5 stars)

  Scenario: a kid requests a reward and no stars are deducted
    When the kid "Iman" requests the reward "Ice Cream"
    Then the request response status is 200
    And the request status is "pending"
    And the kid "Iman" still has 10 saved stars

  Scenario: a duplicate request returns the same pending request
    When the kid "Iman" requests the reward "Ice Cream"
    And the kid "Iman" requests the reward "Ice Cream" again
    Then both requests have the same id
    And there is exactly 1 pending request for the family

  Scenario: the kid rewards list reflects the request status
    When the kid "Iman" requests the reward "Ice Cream"
    And the kid "Iman" GETs their rewards list
    Then the rewards list shows "Ice Cream" with requestStatus "pending"

  Scenario: an admin approves a request and the cost is deducted from savings only
    Given the kid "Iman" has requested the reward "Ice Cream"
    When the admin parent approves the request
    Then the approve response status is 200
    And the approve response status field is "approved"
    And the kid "Iman" has 5 saved stars
    And there is exactly 0 pending request for the family

  Scenario: a non-admin adult cannot approve a request
    Given the kid "Iman" has requested the reward "Ice Cream"
    When the non-admin adult approves the request
    Then the approve response status is 403
    And the kid "Iman" still has 10 saved stars
    And the request status is "pending"

  Scenario: approval is rejected when savings cannot cover the cost
    Given a reward "Big Prize" (100 stars)
    And the kid "Iman" has requested the reward "Big Prize"
    When the admin parent approves the request
    Then the approve response status is 400
    And the kid "Iman" still has 10 saved stars
    And the request status is "pending"

  Scenario: an admin approves when savings exactly cover the cost
    Given a reward "Exact Treat" (10 stars)
    And the kid "Iman" has requested the reward "Exact Treat"
    When the admin parent approves the request
    Then the approve response status is 200
    And the kid "Iman" has 0 saved stars

  Scenario: an admin declines a request with no deduction
    Given the kid "Iman" has requested the reward "Ice Cream"
    When the admin parent declines the request
    Then the decline response status is 200
    And the decline response status field is "declined"
    And the kid "Iman" still has 10 saved stars

  Scenario: the parent list is tenant-isolated
    Given a second family "Smiths" with an admin parent and a kid "Yusuf" who has requested a reward
    When the admin parent lists the family's pending requests
    Then the list contains only this family's requests

  Scenario: an admin cannot approve another family's request
    Given a second family "Smiths" with an admin parent and a kid "Yusuf" who has requested a reward
    When the admin parent approves the other family's request
    Then the approve response status is 404

  Scenario: the kid journal write endpoint is gone
    When the kid "Iman" PUTs their journal
    Then the kid journal write response status is 404
