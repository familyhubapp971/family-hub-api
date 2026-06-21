Feature: Kid profile for the dashboard header

  A logged-in kid's dashboard header shows their own name, avatar, and banked
  stars/cash — scoped to their own member from the verified kid token (FHS-362).

  Background:
    Given a family with kids "Iman" (12 stars, 5.00 cash, avatar) and "Yusuf" (0 stars)

  Scenario: a kid sees their own profile in the header
    When the kid "Iman" GETs /api/kid/profile with their token
    Then the kid profile response status is 200
    And the kid profile name is "Iman"
    And the kid profile avatar is the kid's avatar
    And the kid profile banked stars is 12
    And the kid profile banked cash is 5
    And the kid profile currency is "AED"

  Scenario: a kid's profile is scoped to their own member, never a sibling's
    When the kid "Yusuf" GETs /api/kid/profile with their token
    Then the kid profile response status is 200
    And the kid profile name is "Yusuf"
    And the kid profile banked stars is 0
