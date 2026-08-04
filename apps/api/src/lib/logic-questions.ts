// FHS-395: server-side Logic question bank.
//
// Ported from the legacy frontend/data/logic-questions.ts. All 5 game types ×
// 3 difficulties. Each question carries a stable `id` and the correct answer so
// the grader can verify server-authoritatively. Client-facing accessor (getLogicQuestions)
// strips the answer before sending, mirroring how learn-questions.ts works.
//
// Question counts: truefalse 31/31/31, patterns 30/28/29, oddoneout 29/29/30,
// ifthen 29/29/29, sorting 29/29/30.

export type LogicGameType = 'truefalse' | 'patterns' | 'oddoneout' | 'ifthen' | 'sorting';
export type LogicDifficulty = 'easy' | 'medium' | 'hard';

export const LOGIC_GAME_TYPES: readonly LogicGameType[] = [
  'truefalse',
  'patterns',
  'oddoneout',
  'ifthen',
  'sorting',
];
export const LOGIC_DIFFICULTIES: readonly LogicDifficulty[] = ['easy', 'medium', 'hard'];

// ─── Question shapes ──────────────────────────────────────────────────────────

export interface TrueFalseQuestion {
  id: string;
  type: 'truefalse';
  statement: string;
  answer: boolean;
  explanation: string;
}

export interface PatternQuestion {
  id: string;
  type: 'patterns';
  sequence: string[];
  choices: string[];
  answer: string;
  explanation: string;
}

export interface OddOneOutQuestion {
  id: string;
  type: 'oddoneout';
  items: string[];
  answer: string;
  explanation: string;
}

export interface IfThenQuestion {
  id: string;
  type: 'ifthen';
  premise: string;
  hint: string;
  choices: string[];
  answer: string;
  explanation: string;
}

export interface SortingQuestion {
  id: string;
  type: 'sorting';
  item: string;
  groups: string[];
  answer: string;
  explanation: string;
}

export type LogicQuestion =
  | TrueFalseQuestion
  | PatternQuestion
  | OddOneOutQuestion
  | IfThenQuestion
  | SortingQuestion;

// Client-facing shape: answer stripped.
export type PublicLogicQuestion =
  | Omit<TrueFalseQuestion, 'answer'>
  | Omit<PatternQuestion, 'answer'>
  | Omit<OddOneOutQuestion, 'answer'>
  | Omit<IfThenQuestion, 'answer'>
  | Omit<SortingQuestion, 'answer'>;

// ─── Builder helpers ──────────────────────────────────────────────────────────
//
// IDs are assigned after array construction via tagIds(), NOT by a global
// counter. Format: `${gameType}-${difficulty}-${1-based-index}`.
// This makes every id stable against reorders and insertions within a combo.

type Unidentified<T extends LogicQuestion> = Omit<T, 'id'>;

const tf = (
  statement: string,
  answer: boolean,
  explanation: string,
): Unidentified<TrueFalseQuestion> => ({
  type: 'truefalse',
  statement,
  answer,
  explanation,
});

const pat = (
  sequence: string[],
  choices: string[],
  answer: string,
  explanation: string,
): Unidentified<PatternQuestion> => ({
  type: 'patterns',
  sequence,
  choices,
  answer,
  explanation,
});

const odd = (
  items: string[],
  answer: string,
  explanation: string,
): Unidentified<OddOneOutQuestion> => ({
  type: 'oddoneout',
  items,
  answer,
  explanation,
});

const ift = (
  premise: string,
  hint: string,
  choices: string[],
  answer: string,
  explanation: string,
): Unidentified<IfThenQuestion> => ({
  type: 'ifthen',
  premise,
  hint,
  choices,
  answer,
  explanation,
});

const srt = (
  item: string,
  groups: string[],
  answer: string,
  explanation: string,
): Unidentified<SortingQuestion> => ({
  type: 'sorting',
  item,
  groups,
  answer,
  explanation,
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRUE OR FALSE
// ═══════════════════════════════════════════════════════════════════════════════

const trueFalseEasy: Unidentified<TrueFalseQuestion>[] = [
  tf('A dog is an animal', true, 'Yes! Dogs are animals: they are our furry friends! 🐕'),
  tf('The sun is blue', false, 'The sun looks yellow or orange, not blue! ☀️'),
  tf('Fish live in water', true, "That's right! Fish need water to breathe and swim! 🐟"),
  tf('Cats can fly', false, 'Cats are great at jumping, but they cannot fly! 🐱'),
  tf('Ice is cold', true, "Yes, ice is frozen water and it's very cold! 🧊"),
  tf('A triangle has 4 sides', false, 'A triangle has 3 sides: "tri" means three! 🔺'),
  tf('Bananas are yellow', true, 'Ripe bananas are usually yellow! 🍌'),
  tf('Birds have wings', true, 'Yes! All birds have wings, even penguins! 🐦'),
  tf('Elephants are small animals', false, 'Elephants are the biggest land animals! 🐘'),
  tf('The sky is green', false, 'The sky is usually blue during the day! 🌤️'),
  tf('Spiders have 8 legs', true, "That's right! Spiders always have 8 legs! 🕷️"),
  tf('Apples grow on trees', true, 'Yes! Apples grow on apple trees! 🍎'),
  tf('Fire is cold', false, 'Fire is very hot: never touch it! 🔥'),
  tf('Cows give milk', true, 'Yes! We get milk from cows! 🐄'),
  tf('A circle has corners', false, 'A circle is perfectly round with no corners! ⭕'),
  tf('Snow is white', true, 'Fresh snow is white and fluffy! ❄️'),
  tf('Frogs can jump', true, 'Frogs are amazing jumpers! 🐸'),
  tf('The moon is a star', false, 'The moon is not a star: it reflects light from the sun! 🌙'),
  tf('Horses have hooves', true, 'Yes! Horses walk on their hooves! 🐴'),
  tf('Roses are flowers', true, 'Roses are beautiful flowers! 🌹'),
  tf('Rocks are soft', false, "Rocks are hard! That's what makes them rocks! 🪨"),
  tf('A car has wheels', true, 'Cars roll on wheels to move around! 🚗'),
  tf('Turtles are fast', false, 'Turtles move very slowly: slow and steady! 🐢'),
  tf('Rain comes from clouds', true, 'Clouds hold tiny water drops that fall as rain! 🌧️'),
  tf('A square has 4 sides', true, 'A square has four equal sides! ⬛'),
  tf('Penguins live in the desert', false, 'Penguins live in cold places like Antarctica! 🐧'),
  tf('Butterflies have wings', true, 'Butterflies have beautiful colourful wings! 🦋'),
  tf('Trees can walk', false, "Trees stay rooted in the ground: they don't walk! 🌳"),
  tf('The ocean is salty', true, "Sea water is salty: don't drink it! 🌊"),
  tf('A clock tells us the time', true, 'Clocks show hours and minutes! ⏰'),
  tf('Carrots are purple', false, 'Most carrots are orange, though some are purple! 🥕'),
];

const trueFalseMedium: Unidentified<TrueFalseQuestion>[] = [
  tf('Penguins can fly', false, 'Penguins are birds but they swim instead of flying! 🐧'),
  tf('Water freezes at 0°C', true, 'Yes! Water turns to ice at 0 degrees Celsius! ❄️'),
  tf('The Earth is flat', false, 'The Earth is round like a ball: a sphere! 🌍'),
  tf('Bats are birds', false, 'Bats are actually mammals, not birds! 🦇'),
  tf('Plants need sunlight to grow', true, 'Plants use sunlight to make their food! 🌱'),
  tf('Dolphins are fish', false, 'Dolphins are mammals: they breathe air! 🐬'),
  tf('There are 7 days in a week', true, 'Monday to Sunday makes 7 days! 📅'),
  tf('Camels store water in their humps', false, 'Camel humps store fat, not water! 🐫'),
  tf(
    'Lightning is hotter than the sun',
    true,
    "A lightning bolt is actually hotter than the sun's surface! ⚡",
  ),
  tf('Humans have 5 senses', true, 'Sight, hearing, taste, touch, and smell! 👁️'),
  tf(
    'Owls can turn their heads all the way around',
    false,
    'Owls can turn about 270 degrees, but not a full 360! 🦉',
  ),
  tf(
    'Diamonds are made from carbon',
    true,
    'Yes! Diamonds are just carbon squeezed really hard! 💎',
  ),
  tf('An octopus has 10 arms', false, 'An octopus has 8 arms: "octo" means eight! 🐙'),
  tf('Sound travels faster than light', false, 'Light is much faster than sound! 💡'),
  tf(
    'The Great Wall of China is visible from space',
    false,
    "It's too narrow to see from space with just your eyes! 🧱",
  ),
  tf('Honey never goes bad', true, 'Honey found in ancient tombs was still edible! 🍯'),
  tf(
    'Venus is the closest planet to the Sun',
    false,
    'Mercury is the closest planet to the Sun! ☿️',
  ),
  tf(
    'Butterflies taste with their feet',
    true,
    'Amazing but true! Butterflies have taste sensors on their feet! 🦋',
  ),
  tf(
    'A year on Earth is exactly 365 days',
    false,
    "It's about 365.25 days: that's why we have leap years! 📆",
  ),
  tf('Sharks are mammals', false, 'Sharks are fish: they breathe through gills! 🦈'),
  tf('Rainbows have 7 colours', true, 'Red, orange, yellow, green, blue, indigo, and violet! 🌈'),
  tf(
    'A snail carries its home on its back',
    true,
    "A snail's shell is like a tiny house it carries everywhere! 🐌",
  ),
  tf(
    'The Sahara is the biggest desert',
    true,
    'The Sahara in Africa is the largest hot desert! 🏜️',
  ),
  tf('Whales are the biggest fish', false, 'Whales are mammals, not fish! They breathe air! 🐋'),
  tf('A compass points north', true, 'A compass needle always points toward magnetic north! 🧭'),
  tf(
    'Your brain is a muscle',
    false,
    'The brain is an organ, not a muscle, but it still needs exercise! 🧠',
  ),
  tf('Bees make honey', true, 'Bees collect nectar from flowers to make honey! 🐝'),
  tf('A pentagon has 6 sides', false, 'A pentagon has 5 sides: "penta" means five! ⬠'),
  tf('Volcanoes can erupt underwater', true, 'There are many volcanoes on the ocean floor! 🌋'),
  tf('The heart pumps blood', true, 'Your heart beats all day pumping blood through your body! ❤️'),
  tf(
    'Bears hibernate in summer',
    false,
    "Bears hibernate in winter when it's cold and food is scarce! 🐻",
  ),
];

const trueFalseHard: Unidentified<TrueFalseQuestion>[] = [
  tf(
    'All rectangles are squares',
    false,
    'All squares are rectangles, but not all rectangles are squares! 📐',
  ),
  tf(
    'A tomato is a fruit',
    true,
    'Scientifically, tomatoes are fruits because they have seeds inside! 🍅',
  ),
  tf(
    'Humans use only 10% of their brains',
    false,
    'We use all parts of our brain: just not all at once! 🧠',
  ),
  tf('Glass is a liquid', false, 'Glass is actually a solid: an amorphous solid! 🪟'),
  tf('Goldfish have a 3-second memory', false, 'Goldfish can remember things for months! 🐠'),
  tf('All prime numbers are odd', false, "2 is a prime number and it's even! 🔢"),
  tf(
    'A strawberry is not a true berry',
    true,
    'Strawberries are not true berries, but bananas are! 🍓',
  ),
  tf(
    'Mount Everest is the tallest mountain from base to peak',
    false,
    'Mauna Kea in Hawaii is taller from base to peak: most of it is underwater! 🏔️',
  ),
  tf(
    'Zero is an even number',
    true,
    'Yes! Zero is considered an even number because 0 ÷ 2 = 0 with no remainder! 0️⃣',
  ),
  tf(
    'Bananas are berries',
    true,
    "Scientifically, bananas ARE berries! But strawberries aren't! 🍌",
  ),
  tf(
    'The Pacific Ocean is the largest ocean',
    true,
    'The Pacific is bigger than all the land on Earth combined! 🌊',
  ),
  tf(
    'Ostriches bury their heads in sand',
    false,
    'This is a myth! Ostriches lie flat on the ground to hide! 🦤',
  ),
  tf(
    'A square has more angles than a pentagon',
    false,
    'A square has 4 angles, a pentagon has 5! ⬠',
  ),
  tf('Peanuts are nuts', false, 'Peanuts are actually legumes: they grow underground! 🥜'),
  tf(
    'Your fingernails grow faster than your toenails',
    true,
    'Fingernails grow about 3-4 times faster than toenails! 💅',
  ),
  tf(
    'Australia is both a country and a continent',
    true,
    'Australia is the only place that is both! 🦘',
  ),
  tf(
    'Cold water boils faster than hot water',
    false,
    'Hot water is already closer to boiling, so it boils faster! 🫧',
  ),
  tf(
    'An even number plus an odd number is always odd',
    true,
    'Yes! Like 4 + 3 = 7, which is odd! ➕',
  ),
  tf(
    'A kilogram of steel is heavier than a kilogram of feathers',
    false,
    'They both weigh the same: one kilogram! ⚖️',
  ),
  tf(
    'All squares are rhombuses',
    true,
    'A square has 4 equal sides, which makes it a special rhombus! ◇',
  ),
  tf(
    'The human body has 206 bones',
    true,
    'Adult humans have 206 bones: babies have even more! 🦴',
  ),
  tf('Negative numbers are less than zero', true, 'Numbers like -1, -5 are all below zero! 🔢'),
  tf('A hexagon has 8 sides', false, 'A hexagon has 6 sides: "hex" means six! ⬡'),
  tf(
    'Water is the only substance that expands when it freezes',
    true,
    'Most things shrink when cold, but ice takes up more space than water! 🧊',
  ),
  tf('A leap year has 364 days', false, 'A leap year has 366 days: one extra day in February! 📅'),
  tf(
    'Clouds are made of water vapour',
    true,
    'Clouds are tiny water droplets or ice crystals floating in the air! ☁️',
  ),
  tf(
    'The number pi (π) is exactly 3.14',
    false,
    'Pi goes on forever! 3.14159... It never ends or repeats! 🥧',
  ),
  tf(
    'An isosceles triangle has two equal sides',
    true,
    'Isosceles triangles have exactly two sides the same length! 📐',
  ),
  tf(
    'Venus is the hottest planet',
    true,
    'Venus is hotter than Mercury because of its thick atmosphere! 🌡️',
  ),
  tf(
    'Sound can travel through space',
    false,
    "Space is a vacuum: there's no air for sound waves! 🚀",
  ),
  tf('Fungi are plants', false, 'Fungi (like mushrooms) are their own kingdom: not plants! 🍄'),
];

// ═══════════════════════════════════════════════════════════════════════════════
// PATTERNS
// ═══════════════════════════════════════════════════════════════════════════════

const patternsEasy: Unidentified<PatternQuestion>[] = [
  pat(
    ['1', '2', '3', '4', '?'],
    ['5', '6', '3', '8'],
    '5',
    'We count up by 1 each time: 1, 2, 3, 4, 5! 🔢',
  ),
  pat(
    ['2', '4', '6', '?'],
    ['7', '8', '10', '5'],
    '8',
    'We count up by 2 each time: 2, 4, 6, 8! ✨',
  ),
  pat(
    ['🔴', '🔵', '🔴', '🔵', '?'],
    ['🔴', '🟢', '🔵', '🟡'],
    '🔴',
    'The pattern goes red, blue, red, blue. So next is red! 🔴',
  ),
  pat(
    ['⭐', '⭐', '🌙', '⭐', '⭐', '?'],
    ['⭐', '🌙', '☀️', '💫'],
    '🌙',
    'The pattern is star, star, moon. So next is moon! 🌙',
  ),
  pat(
    ['1', '1', '2', '2', '3', '?'],
    ['3', '4', '1', '2'],
    '3',
    'Each number appears twice: 1,1, 2,2, 3,3! 🎯',
  ),
  pat(
    ['🍎', '🍊', '🍎', '🍊', '?'],
    ['🍎', '🍇', '🍌', '🍊'],
    '🍎',
    'Apple, orange repeats. So next is apple! 🍎',
  ),
  pat(
    ['10', '20', '30', '?'],
    ['35', '40', '50', '25'],
    '40',
    'We add 10 each time: 10, 20, 30, 40! 💪',
  ),
  pat(
    ['🌞', '🌧️', '🌞', '🌧️', '?'],
    ['🌞', '❄️', '🌧️', '⛈️'],
    '🌞',
    'Sunny, rainy repeats. So next is sunny! ☀️',
  ),
  pat(
    ['5', '10', '15', '?'],
    ['18', '20', '25', '16'],
    '20',
    'We add 5 each time: 5, 10, 15, 20! 🎉',
  ),
  pat(
    ['😊', '😊', '😢', '😊', '😊', '?'],
    ['😊', '😢', '😡', '😴'],
    '😢',
    'Two happy, one sad repeats: next is sad! Then happy again! 😊',
  ),
  pat(
    ['🔺', '🔵', '🔺', '🔵', '?'],
    ['🔺', '⬛', '🔵', '🟢'],
    '🔺',
    'Triangle, circle, triangle, circle: next is triangle! 🔺',
  ),
  pat(['A', 'B', 'C', 'D', '?'], ['E', 'F', 'G', 'A'], 'E', 'The alphabet goes A, B, C, D, E! 📝'),
  pat(['3', '6', '9', '?'], ['10', '11', '12', '15'], '12', 'We add 3 each time: 3, 6, 9, 12! 🔢'),
  pat(
    ['🐱', '🐶', '🐱', '🐶', '?'],
    ['🐱', '🐰', '🐶', '🐸'],
    '🐱',
    'Cat, dog, cat, dog: next is cat! 🐱',
  ),
  pat(['1', '3', '5', '?'], ['6', '7', '8', '9'], '7', 'We count odd numbers: 1, 3, 5, 7! 🌟'),
  pat(
    ['🟢', '🟢', '🔴', '🟢', '🟢', '?'],
    ['🟢', '🔴', '🟡', '🔵'],
    '🔴',
    'Green, green, red repeats! Next is red! 🔴',
  ),
  pat(
    ['2', '2', '4', '4', '6', '?'],
    ['6', '8', '7', '5'],
    '6',
    'Each number appears twice: 2,2, 4,4, 6,6! 🎯',
  ),
  pat(
    ['🌸', '🌻', '🌸', '🌻', '?'],
    ['🌸', '🌹', '🌻', '🌷'],
    '🌸',
    'Pink flower, yellow flower alternates! Next is pink! 🌸',
  ),
  pat(
    ['0', '5', '10', '15', '?'],
    ['16', '18', '20', '25'],
    '20',
    'We add 5 each time: 0, 5, 10, 15, 20! 🎊',
  ),
  pat(
    ['👋', '👏', '👋', '👏', '?'],
    ['👋', '🤝', '👏', '✌️'],
    '👋',
    'Wave, clap repeats: next is wave! 👋',
  ),
  pat(
    ['🔵', '🔴', '🔵', '🔴', '?'],
    ['🔵', '🟡', '🟢', '🔴'],
    '🔵',
    'Blue, red alternates: next is blue! 🔵',
  ),
  pat(
    ['4', '8', '12', '?'],
    ['14', '15', '16', '20'],
    '16',
    'We add 4 each time: 4, 8, 12, 16! ➕',
  ),
  pat(
    ['🌕', '🌑', '🌕', '🌑', '?'],
    ['🌕', '⭐', '🌑', '🌞'],
    '🌕',
    'Full moon, new moon alternates: next is full! 🌕',
  ),
  pat(
    ['1', '1', '1', '2', '2', '2', '3', '3', '?'],
    ['3', '4', '1', '2'],
    '3',
    'Each number appears three times: 1,1,1, 2,2,2, 3,3,3! 🎯',
  ),
  pat(
    ['🍎', '🍎', '🍊', '🍎', '🍎', '?'],
    ['🍎', '🍊', '🍇', '🍌'],
    '🍊',
    'Two apples then one orange repeats! Next is orange! 🍊',
  ),
  pat(
    ['7', '14', '21', '?'],
    ['24', '25', '28', '30'],
    '28',
    'We add 7 each time: 7, 14, 21, 28! 🔢',
  ),
  pat(
    ['🟡', '🟡', '🔴', '🟡', '🟡', '?'],
    ['🟡', '🔴', '🟢', '🔵'],
    '🔴',
    'Yellow, yellow, red repeats! Next is red! 🔴',
  ),
  pat(['D', 'E', 'F', 'G', '?'], ['H', 'I', 'A', 'D'], 'H', 'Simple alphabet: D, E, F, G, H! 📖'),
  pat(
    ['9', '8', '7', '6', '?'],
    ['4', '5', '3', '10'],
    '5',
    'We count down by 1: 9, 8, 7, 6, 5! ⬇️',
  ),
  pat(
    ['🐱', '🐱', '🐶', '🐱', '🐱', '?'],
    ['🐱', '🐶', '🐰', '🐸'],
    '🐶',
    'Cat, cat, dog repeats! Next is dog! 🐶',
  ),
];

const patternsMedium: Unidentified<PatternQuestion>[] = [
  pat(
    ['A', 'C', 'E', 'G', '?'],
    ['H', 'I', 'J', 'F'],
    'I',
    'We skip one letter each time: A, C, E, G, I! 📝',
  ),
  pat(
    ['1', '2', '4', '8', '?'],
    ['10', '12', '16', '15'],
    '16',
    'We double each time: 1, 2, 4, 8, 16! 🔢',
  ),
  pat(
    ['🌑', '🌓', '🌕', '🌗', '?'],
    ['🌑', '🌕', '🌓', '⭐'],
    '🌑',
    'The moon cycle repeats: new, half, full, half, new! 🌑',
  ),
  pat(
    ['100', '90', '80', '?'],
    ['75', '70', '60', '85'],
    '70',
    'We subtract 10 each time: 100, 90, 80, 70! 📉',
  ),
  pat(
    ['2', '6', '10', '14', '?'],
    ['16', '18', '20', '15'],
    '18',
    'We add 4 each time: 2, 6, 10, 14, 18! ➕',
  ),
  pat(
    ['🟩', '🟨', '🟥', '🟩', '🟨', '?'],
    ['🟩', '🟥', '🟨', '🟦'],
    '🟥',
    'Green, yellow, red repeats! Next is red! 🟥',
  ),
  pat(
    ['Z', 'Y', 'X', 'W', '?'],
    ['U', 'V', 'T', 'S'],
    'V',
    'The alphabet backwards: Z, Y, X, W, V! 🔄',
  ),
  pat(
    ['1', '4', '9', '16', '?'],
    ['20', '22', '25', '24'],
    '25',
    'These are square numbers: 1², 2², 3², 4², 5²=25! 🧮',
  ),
  pat(
    ['🌕', '🌕', '⭐', '🌕', '🌕', '⭐', '?'],
    ['🌕', '⭐', '🌞', '🌙'],
    '🌕',
    'Moon, moon, star repeats: next is moon! 🌕',
  ),
  pat(
    ['3', '6', '12', '24', '?'],
    ['30', '36', '48', '42'],
    '48',
    'We multiply by 2 each time: 3, 6, 12, 24, 48! ✖️',
  ),
  pat(
    ['11', '22', '33', '?'],
    ['40', '44', '55', '43'],
    '44',
    'We add 11 each time: 11, 22, 33, 44! 🔢',
  ),
  pat(
    ['🔴', '🔵', '🟢', '🔴', '🔵', '?'],
    ['🔴', '🟢', '🟡', '🔵'],
    '🟢',
    'Red, blue, green repeats! Next is green! 🟢',
  ),
  pat(
    ['B', 'D', 'F', 'H', '?'],
    ['I', 'J', 'K', 'G'],
    'J',
    'We skip one letter: B, D, F, H, J! 📝',
  ),
  pat(
    ['50', '45', '40', '35', '?'],
    ['25', '30', '33', '20'],
    '30',
    'We subtract 5 each time: 50, 45, 40, 35, 30! ⬇️',
  ),
  pat(
    ['1', '3', '6', '10', '?'],
    ['12', '13', '15', '14'],
    '15',
    'We add 2, then 3, then 4, then 5 = 15! These are triangle numbers! 🔺',
  ),
  pat(
    ['🍎', '🍊', '🍋', '🍎', '🍊', '?'],
    ['🍎', '🍋', '🍊', '🍇'],
    '🍋',
    'Apple, orange, lemon repeats! Next is lemon! 🍋',
  ),
  pat(
    ['20', '18', '16', '14', '?'],
    ['13', '12', '10', '11'],
    '12',
    'We subtract 2 each time: 20, 18, 16, 14, 12! ⬇️',
  ),
  pat(
    ['5', '10', '20', '40', '?'],
    ['50', '60', '80', '70'],
    '80',
    'We double each time: 5, 10, 20, 40, 80! 🚀',
  ),
  pat(
    ['🐶', '🐱', '🐰', '🐶', '🐱', '?'],
    ['🐶', '🐰', '🐱', '🐸'],
    '🐰',
    'Dog, cat, rabbit repeats! Next is rabbit! 🐰',
  ),
  pat(['M', 'N', 'O', 'P', '?'], ['Q', 'R', 'S', 'O'], 'Q', 'Simple alphabet: M, N, O, P, Q! 📖'),
  pat(
    ['4', '8', '16', '32', '?'],
    ['36', '48', '64', '56'],
    '64',
    'We double each time: 4, 8, 16, 32, 64! 🚀',
  ),
  pat(
    ['1', '1', '2', '1', '1', '2', '?'],
    ['1', '2', '3', '0'],
    '1',
    'The pattern 1,1,2 repeats! Next is 1! 🔁',
  ),
  pat(
    ['🔵', '🟡', '🔴', '🔵', '🟡', '?'],
    ['🔵', '🔴', '🟡', '🟢'],
    '🔴',
    'Blue, yellow, red repeats! Next is red! 🔴',
  ),
  pat(
    ['25', '20', '15', '10', '?'],
    ['8', '5', '0', '3'],
    '5',
    'We subtract 5 each time: 25, 20, 15, 10, 5! ⬇️',
  ),
  pat(
    ['C', 'E', 'G', 'I', '?'],
    ['J', 'K', 'L', 'H'],
    'K',
    'We skip one letter: C, E, G, I, K! 📝',
  ),
  pat(
    ['🌞', '🌞', '🌧️', '🌞', '🌞', '🌧️', '?'],
    ['🌞', '🌧️', '❄️', '⛈️'],
    '🌞',
    'Sunny, sunny, rainy repeats! Next starts again with sunny! ☀️',
  ),
  pat(
    ['7', '14', '21', '28', '?'],
    ['30', '33', '35', '42'],
    '35',
    'We add 7 each time: 7, 14, 21, 28, 35! 🔢',
  ),
  pat(
    ['🎵', '🎵', '🎶', '🎵', '🎵', '?'],
    ['🎵', '🎶', '🎧', '🎸'],
    '🎶',
    'Two notes then a double note repeats! 🎶',
  ),
];

const patternsHard: Unidentified<PatternQuestion>[] = [
  pat(
    ['1', '1', '2', '3', '5', '?'],
    ['6', '7', '8', '9'],
    '8',
    'Each number is the sum of the two before: 3+5=8! This is the Fibonacci sequence! 🌀',
  ),
  pat(
    ['1', '4', '9', '16', '25', '?'],
    ['30', '33', '36', '49'],
    '36',
    'Square numbers: 1², 2², 3², 4², 5², 6²=36! 🔢',
  ),
  pat(
    ['2', '3', '5', '7', '11', '?'],
    ['12', '13', '14', '15'],
    '13',
    'These are prime numbers! The next prime after 11 is 13! 🔎',
  ),
  pat(
    ['1', '8', '27', '64', '?'],
    ['100', '125', '81', '216'],
    '125',
    'Cube numbers: 1³, 2³, 3³, 4³, 5³=125! 🧊',
  ),
  pat(
    ['🔴', '🔵', '🔵', '🔴', '🔵', '🔵', '🔵', '?'],
    ['🔴', '🔵', '🟢', '🟡'],
    '🔴',
    'Red then 2 blues, red then 3 blues: next red starts the next group! 🔴',
  ),
  pat(
    ['2', '6', '12', '20', '?'],
    ['24', '28', '30', '32'],
    '30',
    'The differences grow by 2: +4, +6, +8, +10 = 30! 📈',
  ),
  pat(
    ['1', '2', '4', '7', '11', '?'],
    ['13', '14', '15', '16'],
    '16',
    'We add 1, then 2, then 3, then 4, then 5 = 16! 🎯',
  ),
  pat(
    ['81', '27', '9', '3', '?'],
    ['0', '1', '2', '6'],
    '1',
    'We divide by 3 each time: 81÷3=27÷3=9÷3=3÷3=1! ➗',
  ),
  pat(
    ['A', 'Z', 'B', 'Y', 'C', '?'],
    ['D', 'X', 'W', 'V'],
    'X',
    'We alternate: A,B,C from the start and Z,Y,X from the end! 🔄',
  ),
  pat(
    ['0', '1', '1', '2', '3', '5', '?'],
    ['6', '7', '8', '9'],
    '8',
    'Fibonacci! Each number = sum of previous two: 3+5=8! 🌻',
  ),
  pat(
    ['256', '128', '64', '32', '?'],
    ['24', '16', '8', '28'],
    '16',
    'We divide by 2 each time: 256→128→64→32→16! ➗',
  ),
  pat(
    ['1', '3', '7', '15', '?'],
    ['23', '29', '31', '27'],
    '31',
    'We double and add 1: 1→3→7→15→31! (×2+1 each time) 🔢',
  ),
  pat(
    ['🔺', '🔺', '⬛', '🔺', '🔺', '🔺', '⬛', '?'],
    ['🔺', '⬛', '🔵', '🟢'],
    '🔺',
    'The triangles grow: 2 tri, square, 3 tri, square: next starts 4 triangles! 🔺',
  ),
  pat(
    ['10', '11', '13', '16', '20', '?'],
    ['22', '23', '24', '25'],
    '25',
    'We add 1, then 2, then 3, then 4, then 5 = 25! 📈',
  ),
  pat(
    ['1000', '500', '250', '?'],
    ['100', '125', '200', '150'],
    '125',
    'We halve each time: 1000→500→250→125! ➗',
  ),
  pat(
    ['3', '5', '9', '15', '23', '?'],
    ['28', '29', '31', '33'],
    '33',
    'Differences grow by 2: +2, +4, +6, +8, +10=33! 🎯',
  ),
  pat(
    ['1', '2', '3', '5', '8', '13', '?'],
    ['15', '18', '20', '21'],
    '21',
    'Fibonacci! 8+13=21! Each number is the sum of the two before! 🌀',
  ),
  pat(
    ['64', '32', '16', '8', '4', '?'],
    ['3', '2', '1', '0'],
    '2',
    'We divide by 2 each time: 64→32→16→8→4→2! ➗',
  ),
  pat(
    ['🟡', '🟠', '🔴', '🟡', '🟠', '🔴', '?'],
    ['🟡', '🔵', '🟢', '🟠'],
    '🟡',
    'Yellow, orange, red repeats! Back to yellow! 🟡',
  ),
  pat(
    ['2', '5', '10', '17', '26', '?'],
    ['33', '35', '37', '39'],
    '37',
    'Differences are 3,5,7,9,11: next adds 11 = 37! 🧮',
  ),
  pat(
    ['100', '50', '25', '?'],
    ['10', '12.5', '15', '20'],
    '12.5',
    'We halve each time: 100→50→25→12.5! ➗',
  ),
  pat(
    ['1', '3', '9', '27', '?'],
    ['54', '63', '72', '81'],
    '81',
    'We multiply by 3 each time: 1, 3, 9, 27, 81! ✖️',
  ),
  pat(
    ['🔺', '⬛', '⬛', '🔺', '⬛', '⬛', '⬛', '?'],
    ['🔺', '⬛', '🔵', '🟢'],
    '🔺',
    'Triangle then 2 squares, triangle then 3 squares: next triangle starts group! 🔺',
  ),
  pat(
    ['2', '4', '8', '14', '22', '?'],
    ['28', '30', '32', '34'],
    '32',
    'Differences grow by 2: +2, +4, +6, +8, +10=32! 📈',
  ),
  pat(
    ['1', '4', '2', '5', '3', '?'],
    ['4', '5', '6', '7'],
    '6',
    'Two sequences woven together: 1,2,3 and 4,5,6! 🔢',
  ),
  pat(
    ['720', '120', '24', '6', '?'],
    ['1', '2', '3', '4'],
    '2',
    'Factorials going down! 6!=720, 5!=120, 4!=24, 3!=6, 2!=2! 🧮',
  ),
  pat(
    ['3', '7', '15', '31', '?'],
    ['45', '55', '63', '47'],
    '63',
    'We double and add 1: 3→7→15→31→63! (×2+1) 🔢',
  ),
  pat(
    ['🟠', '🟡', '🟢', '🔵', '?'],
    ['🔴', '🟣', '⚫', '⚪'],
    '🟣',
    'Rainbow order! After blue comes indigo/purple! 🌈',
  ),
  pat(
    ['4', '9', '16', '25', '36', '?'],
    ['44', '46', '48', '49'],
    '49',
    'Perfect squares: 2², 3², 4², 5², 6², 7²=49! 🧮',
  ),
];

// ═══════════════════════════════════════════════════════════════════════════════
// ODD ONE OUT
// ═══════════════════════════════════════════════════════════════════════════════

const oddOneOutEasy: Unidentified<OddOneOutQuestion>[] = [
  odd(
    ['🍎', '🍌', '🍊', '🚗'],
    '🚗',
    'The car is not a fruit! The others are all yummy fruits! 🍇',
  ),
  odd(
    ['🐶', '🐱', '🐰', '🏠'],
    '🏠',
    'The house is not an animal! The others are all furry pets! 🐾',
  ),
  odd(
    ['🔴', '🔵', '🟢', '🍕'],
    '🍕',
    'Pizza is food, not a colour! The others are all colours! 🎨',
  ),
  odd(
    ['✈️', '🚗', '🚌', '🎸'],
    '🎸',
    'A guitar is not a vehicle! The others can carry people places! 🎵',
  ),
  odd(
    ['👟', '🥾', '👠', '🎩'],
    '🎩',
    'A hat goes on your head, not your feet! The others are all shoes! 👞',
  ),
  odd(['🌞', '🌙', '⭐', '🍦'], '🍦', 'Ice cream is a treat, not something in the sky! 🍨'),
  odd(
    ['🐟', '🐠', '🦈', '🐔'],
    '🐔',
    'A chicken lives on land! The others all live in the sea! 🌊',
  ),
  odd(
    ['📚', '📖', '📕', '⚽'],
    '⚽',
    'A football is for playing, not reading! The others are all books! ⚽',
  ),
  odd(
    ['🪑', '🛋️', '🛏️', '🌳'],
    '🌳',
    'A tree grows outside! The others are all furniture you sit or lie on! 🏡',
  ),
  odd(
    ['🎹', '🎸', '🥁', '🔨'],
    '🔨',
    'A hammer is a tool, not an instrument! The others make music! 🎶',
  ),
  odd(['🍓', '🫐', '🍇', '🥕'], '🥕', 'A carrot is a vegetable! The others are all berries! 🫐'),
  odd(['1', '2', '3', 'A'], 'A', 'A is a letter, not a number! The others are all numbers! 🔢'),
  odd(['🐄', '🐑', '🐖', '🦁'], '🦁', 'A lion is wild! The others are all farm animals! 🚜'),
  odd(['❄️', '🧊', '🌨️', '🔥'], '🔥', 'Fire is hot! The others are all cold things! 🥶'),
  odd(['🚲', '🛴', '🛹', '📺'], '📺', "A TV doesn't have wheels! The others all have wheels! 🛞"),
  odd(
    ['🧁', '🍰', '🎂', '🥦'],
    '🥦',
    'Broccoli is a vegetable! The others are all sweet treats! 🍬',
  ),
  odd(
    ['🦁', '🐯', '🐻', '🐸'],
    '🐸',
    'A frog is not a mammal! The others are all big furry animals! 🐾',
  ),
  odd(
    ['✏️', '🖊️', '🖍️', '🥄'],
    '🥄',
    'A spoon is for eating! The others are all for writing or drawing! ✍️',
  ),
  odd(
    ['🌈', '🔴', '🔵', '🟡'],
    '🌈',
    'A rainbow has ALL the colours! The others are single colours! 🎨',
  ),
  odd(
    ['🧤', '🧣', '🧥', '👙'],
    '👙',
    'A swimsuit is for hot weather! The others keep you warm in winter! 🥶',
  ),
  odd(
    ['🍕', '🍔', '🌮', '🥤'],
    '🥤',
    'A drink is not food you chew! The others are all things you eat! 🍽️',
  ),
  odd(['🚂', '🚗', '🚌', '🌙'], '🌙', 'The moon is in space! The others are all vehicles! 🚗'),
  odd(
    ['🖍️', '✏️', '🖊️', '🍰'],
    '🍰',
    'Cake is for eating! The others are for writing and drawing! ✏️',
  ),
  odd(['🐓', '🐄', '🐑', '🦁'], '🦁', 'A lion is wild! The others are farm animals! 🚜'),
  odd(
    ['🎈', '🎁', '🎂', '📘'],
    '📘',
    "A book isn't a party item! The others are for celebrations! 🎉",
  ),
  odd(['🍋', '🍑', '🍒', '🧅'], '🧅', 'An onion is a vegetable! The others are all fruits! 🍏'),
  odd(
    ['⚽', '🏀', '🎾', '🎨'],
    '🎨',
    'A palette is for art! The others are all balls for sports! 🏐',
  ),
  odd(['🌻', '🌹', '🌺', '🍄'], '🍄', 'A mushroom is a fungus! The others are all flowers! 🌸'),
  odd(
    ['👁️', '👂', '👃', '👋'],
    '👋',
    "A hand wave isn't a sense organ! The others are eyes, ears, and nose! 🧑",
  ),
];

const oddOneOutMedium: Unidentified<OddOneOutQuestion>[] = [
  odd(
    ['🐄', '🐑', '🐖', '🐙'],
    '🐙',
    'An octopus lives in the ocean! The others are all farm animals! 🌊',
  ),
  odd(
    ['🥕', '🥦', '🥒', '🍕'],
    '🍕',
    'Pizza is not a vegetable! The others are all healthy veggies! 🥗',
  ),
  odd(
    ['🌍', '🌎', '🌏', '🌞'],
    '🌞',
    'The Sun is a star! The others are all views of planet Earth! 🌍',
  ),
  odd(
    ['🎾', '⚽', '🏀', '🎨'],
    '🎨',
    'A paintbrush is for art! The others are all sports balls! 🏆',
  ),
  odd(
    ['Monday', 'Tuesday', 'March', 'Friday'],
    'March',
    'March is a month, not a day of the week! 📅',
  ),
  odd(['🦅', '🦆', '🐧', '🐊'], '🐊', 'A crocodile is a reptile! The others are all birds! 🐦'),
  odd(
    ['🎻', '🎹', '🎺', '🎧'],
    '🎧',
    "Headphones play music but aren't instruments! The others are all musical instruments! 🎵",
  ),
  odd(['🥛', '💧', '🧃', '🍞'], '🍞', 'Bread is solid! The others are all drinks or liquids! 🥤'),
  odd(
    ['Mercury', 'Venus', 'Earth', 'Moon'],
    'Moon',
    'The Moon is not a planet! The others orbit the Sun! 🌑',
  ),
  odd(
    ['🏊', '🚣', '🤿', '⛷️'],
    '⛷️',
    'Skiing is done on snow! The others are all water sports! 💧',
  ),
  odd(
    ['🦷', '💀', '🦴', '💪'],
    '💪',
    'Muscles are soft tissue! The others are all hard bones or teeth! 🦴',
  ),
  odd(['🍕', '🍔', '🌮', '🥗'], '🥗', 'Salad is healthy! The others are all fast food! 🍟'),
  odd(
    ['Spring', 'Summer', 'Autumn', 'January'],
    'January',
    'January is a month! The others are seasons! 🍂',
  ),
  odd(['🐝', '🐛', '🦋', '🐍'], '🐍', 'A snake is a reptile! The others are all insects! 🐜'),
  odd(['🚂', '🚗', '🚌', '⛵'], '⛵', 'A sailboat travels on water! The others drive on roads! 🛣️'),
  odd(
    ['🧲', '📎', '🔑', '🧸'],
    '🧸',
    "A teddy bear isn't metal! The others are all made of metal! 🔩",
  ),
  odd(
    ['🌲', '🌳', '🌴', '🌺'],
    '🌺',
    'A flower is not a tree! The others are all different types of trees! 🌳',
  ),
  odd(
    ['🎪', '🎠', '🎢', '📚'],
    '📚',
    'A book is not a fairground ride! The others are all at a fair! 🎡',
  ),
  odd(
    ['👑', '🎩', '🧢', '👟'],
    '👟',
    'A shoe goes on your feet! The others all go on your head! 🤠',
  ),
  odd(
    ['🌊', '🏖️', '🐚', '🏔️'],
    '🏔️',
    'A mountain is not at the beach! The others are all seaside things! 🏖️',
  ),
  odd(
    ['🎤', '🎸', '🥁', '📷'],
    '📷',
    'A camera is for photos! The others all make or amplify music! 🎵',
  ),
  odd(
    ['🏰', '🏠', '🏢', '🌲'],
    '🌲',
    'A tree is not a building! The others are all structures! 🏗️',
  ),
  odd(
    ['🥊', '⚽', '🏊', '📖'],
    '📖',
    'A book is not a sport! The others are all physical activities! 💪',
  ),
  odd(
    ['Saturn', 'Jupiter', 'Neptune', 'Sun'],
    'Sun',
    'The Sun is a star! The others are all planets! ⭐',
  ),
  odd(
    ['🧈', '🧀', '🥛', '🥩'],
    '🥩',
    'Meat is not a dairy product! The others all come from milk! 🐄',
  ),
  odd(
    ['🎻', '🎷', '🎺', '🏈'],
    '🏈',
    'A football is for sports! The others are all musical instruments! 🎼',
  ),
  odd(['🐝', '🐜', '🦗', '🐌'], '🐌', 'A snail is a mollusc! The others are all insects! 🐛'),
  odd(
    ['📐', '📏', '✏️', '🍎'],
    '🍎',
    'An apple is a fruit! The others are all school supplies! 🏫',
  ),
  odd(['🌙', '⭐', '☀️', '🌸'], '🌸', 'A flower is on Earth! The others are all in the sky! 🌌'),
];

const oddOneOutHard: Unidentified<OddOneOutQuestion>[] = [
  odd(['2', '4', '6', '9'], '9', '9 is odd! The others are all even numbers! 🔢'),
  odd(
    ['cat', 'bat', 'hat', 'dog'],
    'dog',
    '"Dog" doesn\'t rhyme! The others all rhyme: cat, bat, hat! 🎤',
  ),
  odd(['🟥', '🟧', '🟨', '🟦'], '🟦', 'Blue is a cool colour! The others are all warm colours! 🎨'),
  odd(
    ['🥇', '🥈', '🥉', '🏅'],
    '🏅',
    'The gold medal has no rank! The others are 1st, 2nd, and 3rd place! 🏆',
  ),
  odd(['16', '25', '36', '30'], '30', '30 is not a perfect square! 16=4², 25=5², 36=6²! 🔢'),
  odd(
    ['🐜', '🐝', '🕷️', '🦋'],
    '🕷️',
    'Spiders have 8 legs! The others are all insects with 6 legs! 🦗',
  ),
  odd(
    ['🌞', '💡', '🕯️', '🌙'],
    '🌙',
    "The moon doesn't make its own light! The others all produce light! 💡",
  ),
  odd(
    ['H₂O', 'CO₂', 'NaCl', '🧪'],
    '🧪',
    'A test tube is equipment, not a chemical formula! The others are all formulas! ⚗️',
  ),
  odd(
    ['Square', 'Rectangle', 'Circle', 'Triangle'],
    'Circle',
    'A circle has no straight sides! The others all have straight edges! 📐',
  ),
  odd(['🦁', '🐯', '🐆', '🐺'], '🐺', 'A wolf is not a big cat! The others are all felines! 🐱'),
  odd(
    ['🍕', '🌮', '🍔', '🍣'],
    '🍣',
    'Sushi is from Japan! The others are all Western fast food! 🗾',
  ),
  odd(['1', '3', '5', '8'], '8', '8 is even! The others are all odd numbers! 🔢'),
  odd(
    ['🐋', '🐬', '🐙', '🦈'],
    '🐙',
    'An octopus is an invertebrate! The others are all vertebrates! 🦴',
  ),
  odd(['🎸', '🎻', '🎹', '🥁'], '🥁', 'You hit drums: no strings! The others all have strings! 🎵'),
  odd(
    ['Earth', 'Mars', 'Jupiter', 'Moon'],
    'Moon',
    'The Moon orbits Earth, not the Sun! The others are planets! 🪐',
  ),
  odd(
    ['😊', '😄', '😢', '😃'],
    '😢',
    'Sad face is not happy! The others are all happy expressions! 😊',
  ),
  odd(
    ['🟢', '🟢', '🟢', '🟩'],
    '🟩',
    'The square is a different shape! The others are all circles! ⭕',
  ),
  odd(
    ['10', '15', '20', '23'],
    '23',
    '23 is not divisible by 5! The others are all multiples of 5! 🔢',
  ),
  odd(
    ['🌊', '❄️', '💧', '🔥'],
    '🔥',
    'Fire is not water in any form! The others are all forms of water (liquid, solid, liquid)! 💧',
  ),
  odd(
    ['🐔', '🦆', '🐧', '🦅'],
    '🐔',
    'Chickens can barely fly! The others are all good flyers or swimmers! 🐦',
  ),
  odd(['3', '7', '11', '4'], '4', '4 is even! The others are all odd numbers! 🔢'),
  odd(['🌍', '🌏', '🌎', '☀️'], '☀️', 'The Sun is a star! The others are all views of Earth! 🌐'),
  odd(['🍫', '🍬', '🍭', '🥕'], '🥕', 'A carrot is healthy! The others are all sweets! 🍬'),
  odd(['🐕', '🐩', '🐈', '🐕‍🦺'], '🐈', 'A cat is not a dog! The others are all dog breeds! 🐶'),
  odd(
    ['cube', 'sphere', 'pyramid', 'circle'],
    'circle',
    'A circle is 2D! The others are all 3D shapes! 📐',
  ),
  odd(
    ['🔋', '💡', '🔌', '🎩'],
    '🎩',
    'A hat is clothing! The others all relate to electricity! ⚡',
  ),
  odd(
    ['🐠', '🦈', '🐡', '🐸'],
    '🐸',
    'A frog is an amphibian that lives on land! The others are all sea creatures! 🌊',
  ),
  odd(
    ['12', '24', '36', '50'],
    '50',
    '50 is not divisible by 12! The others are all multiples of 12! 🔢',
  ),
  odd(
    ['🎹', '🎸', '🎻', '🎺'],
    '🎺',
    'A trumpet is a brass instrument! The others all have keys or strings! 🎵',
  ),
  odd(['📘', '📗', '📕', '📺'], '📺', 'A TV is electronic! The others are all books! 📚'),
];

// ═══════════════════════════════════════════════════════════════════════════════
// IF...THEN
// ═══════════════════════════════════════════════════════════════════════════════

const ifThenEasy: Unidentified<IfThenQuestion>[] = [
  ift(
    'If it is raining outside...',
    'Think about what keeps you dry! ☂️',
    [
      'You need an umbrella ☂️',
      'You need sunglasses 🕶️',
      'You need a swimsuit 👙',
      'You need a skateboard 🛹',
    ],
    'You need an umbrella ☂️',
    'When it rains, an umbrella keeps you dry! ☔',
  ),
  ift(
    'If you are hungry...',
    'What do you do when your tummy rumbles? 🤔',
    ['You should eat food 🍽️', 'You should sleep 😴', 'You should run 🏃', 'You should sing 🎵'],
    'You should eat food 🍽️',
    "When you're hungry, eating food fills your tummy! 🍎",
  ),
  ift(
    'If it is dark outside...',
    'When does it get dark? Think about the time of day! 🕐',
    ['It is night time 🌙', 'It is lunch time 🍽️', 'It is summer ☀️', 'It is raining 🌧️'],
    'It is night time 🌙',
    "When it's dark, the sun has set and it's night! 🌃",
  ),
  ift(
    'If you drop a ball...',
    'What pulls things toward the ground? 🌍',
    ['It falls down ⬇️', 'It flies up ⬆️', 'It disappears 💨', 'It turns green 🟢'],
    'It falls down ⬇️',
    'Gravity pulls things down toward the ground! 🌍',
  ),
  ift(
    'If you are cold...',
    'What helps keep you warm? 🧣',
    ['Put on a jumper 🧥', 'Take off your shoes 👟', 'Eat ice cream 🍦', 'Go swimming 🏊'],
    'Put on a jumper 🧥',
    "A warm jumper helps you warm up when you're cold! 🧣",
  ),
  ift(
    'If a traffic light is red...',
    'What does the red colour mean for cars? 🚦',
    ['Cars must stop 🛑', 'Cars go fast 🏎️', 'Cars turn left ↩️', 'Cars honk 📢'],
    'Cars must stop 🛑',
    'Red means stop! It keeps everyone safe! 🚦',
  ),
  ift(
    'If you plant a seed and water it...',
    'Seeds need water and sunlight to become something amazing! ☀️',
    ['A plant will grow 🌱', 'A rock will appear 🪨', 'Nothing happens 🤷', 'It turns to gold ✨'],
    'A plant will grow 🌱',
    'Seeds need water and sunlight to grow into plants! 🌻',
  ),
  ift(
    'If you mix red and blue paint...',
    'Think about what colour you get when mixing! 🎨',
    ['You get purple 💜', 'You get green 💚', 'You get orange 🧡', 'You get white 🤍'],
    'You get purple 💜',
    'Red + blue = purple! Mixing colours is so fun! 🎨',
  ),
  ift(
    'If a dog wags its tail...',
    'Dogs show their feelings with their tails! 🐕',
    ['It is happy 😊', 'It is angry 😠', 'It is sleeping 😴', 'It is hungry 🍖'],
    'It is happy 😊',
    "Dogs wag their tails when they're happy to see you! 🐕",
  ),
  ift(
    'If you turn off the lights...',
    'What happens in a room without any light? 💡',
    ['The room goes dark 🌑', 'The room gets hot 🔥', 'Music plays 🎵', 'Food appears 🍕'],
    'The room goes dark 🌑',
    "Without lights, we can't see in the room! 💡",
  ),
  ift(
    'If you put ice in the sun...',
    'The sun makes things very warm! What happens to ice when it gets warm? ☀️',
    ['It melts 💧', 'It gets bigger 📏', 'It turns red 🔴', 'It floats away 🎈'],
    'It melts 💧',
    'Heat from the sun turns ice back into water! ☀️',
  ),
  ift(
    'If you read books every day...',
    "Books are full of wonderful things you didn't know! 📚",
    ['You learn new things 📚', 'You get taller 📏', 'You turn invisible 👻', 'Your hair grows 💇'],
    'You learn new things 📚',
    'Reading helps your brain learn amazing things! 🧠',
  ),
  ift(
    'If you brush your teeth...',
    'Brushing gets rid of nasty germs on your teeth! 🪥',
    [
      'They stay clean and healthy 🦷',
      'They turn blue 🔵',
      'They get bigger 📏',
      'They fall out 😱',
    ],
    'They stay clean and healthy 🦷',
    'Brushing keeps your teeth strong and sparkly! ✨',
  ),
  ift(
    'If you touch something hot...',
    'Hot things can be dangerous! Be careful! ⚠️',
    ['You might get burned 🔥', 'You get stronger 💪', 'It turns cold ❄️', 'Nothing happens 🤷'],
    'You might get burned 🔥',
    'Always be careful around hot things! 🫶',
  ),
  ift(
    'If you add 2 + 2...',
    'Count on your fingers: 1, 2... then 3, 4! 🖐️',
    ['You get 4', 'You get 5', 'You get 3', 'You get 22'],
    'You get 4',
    'Two plus two equals four! 🔢',
  ),
  ift(
    'If birds fly south in autumn...',
    'Think about why animals move to different places! 🐦',
    [
      'They want warmer weather ☀️',
      'They want more snow ❄️',
      'They are lost 🗺️',
      'They are scared 😨',
    ],
    'They want warmer weather ☀️',
    "Birds migrate south where it's warm in winter! 🐦",
  ),
  ift(
    'If you throw a stone in water...',
    'Stones are heavy: what happens when heavy things go in water? 💦',
    ['It makes a splash 💦', 'It flies up ⬆️', 'It disappears 💨', 'It sings 🎵'],
    'It makes a splash 💦',
    'Stones are heavy and go splash into the water! 🌊',
  ),
  ift(
    'If you say please...',
    'Being kind and polite is always a good idea! ❤️',
    [
      'People are more likely to help 😊',
      'It starts raining 🌧️',
      'Time stops ⏰',
      'Cats appear 🐱',
    ],
    'People are more likely to help 😊',
    'Being polite makes everyone happy! ❤️',
  ),
  ift(
    'If you water flowers...',
    'Flowers get thirsty just like you! 🌺',
    ['They grow and bloom 🌸', 'They shrink 📉', 'They fly away 🕊️', 'They sing 🎶'],
    'They grow and bloom 🌸',
    'Flowers need water to grow big and beautiful! 🌺',
  ),
  ift(
    'If the alarm clock rings...',
    'What is an alarm clock for? Think about your morning! ⏰',
    ["It's time to wake up ⏰", "It's time to sleep 😴", 'The TV turns on 📺', 'Lunch is ready 🍽️'],
    "It's time to wake up ⏰",
    'Alarm clocks help us wake up on time! 🌅',
  ),
  ift(
    'If you mix yellow and blue...',
    'Think about what colour you see when these two mix! 🎨',
    ['You get green 💚', 'You get red ❤️', 'You get purple 💜', 'You get black 🖤'],
    'You get green 💚',
    'Yellow + blue = green! Try it with paint! 🎨',
  ),
  ift(
    'If you wear shoes that are too small...',
    'Imagine squeezing your feet into tiny shoes! 👟',
    [
      'Your feet will hurt 🦶',
      "You'll run faster 🏃",
      'They will grow bigger 📏',
      'Nothing happens 🤷',
    ],
    'Your feet will hurt 🦶',
    'Shoes that are too tight squeeze your feet! 👟',
  ),
  ift(
    'If a caterpillar grows up...',
    'Caterpillars go through an amazing change! 🦋',
    [
      'It becomes a butterfly 🦋',
      'It becomes a bird 🐦',
      'It becomes a fish 🐟',
      'It stays the same 🐛',
    ],
    'It becomes a butterfly 🦋',
    'Caterpillars transform into beautiful butterflies! 🌸',
  ),
  ift(
    'If you put seeds in dark soil with no light...',
    'Plants need something from the sky to grow! ☀️',
    [
      'Plants will not grow well 🌑',
      'Plants grow faster 🚀',
      'Seeds turn to stone 🪨',
      'Nothing changes 🤷',
    ],
    'Plants will not grow well 🌑',
    'Plants need sunlight to make food and grow! ☀️',
  ),
  ift(
    'If you blow air into a balloon...',
    'When you fill something with air, it stretches! 🎈',
    ['It gets bigger 🎈', 'It gets smaller 📉', 'It turns heavy 🏋️', 'It disappears 💨'],
    'It gets bigger 🎈',
    'Air fills the balloon and stretches it bigger! 🎈',
  ),
  ift(
    'If you count backwards from 5...',
    'Start at 5 and go down: 5, 4, 3... 🔢',
    [
      'You say 5, 4, 3, 2, 1',
      'You say 5, 6, 7, 8, 9',
      'You say 1, 2, 3, 4, 5',
      'You say 5, 5, 5, 5, 5',
    ],
    'You say 5, 4, 3, 2, 1',
    'Counting backwards means going down! 5, 4, 3, 2, 1... go! 🚀',
  ),
  ift(
    'If the wind blows very hard...',
    'Strong wind can push and move things! 🌬️',
    ['Trees sway and bend 🌬️', 'The sky turns green 💚', 'Rocks fly up ⬆️', 'Rain stops 🛑'],
    'Trees sway and bend 🌬️',
    'Strong wind makes trees move back and forth! 🌳',
  ),
  ift(
    'If a baby chick hatches from an egg...',
    'Think about which animal lays eggs that chicks come from! 🥚',
    [
      'It came from a chicken 🐔',
      'It came from a dog 🐶',
      'It fell from the sky 🌤️',
      'It grew from a seed 🌱',
    ],
    'It came from a chicken 🐔',
    'Mother hens lay eggs that hatch into chicks! 🐣',
  ),
  ift(
    'If you look at the sky at night...',
    'The night sky is full of beautiful twinkling things! ✨',
    [
      'You see stars and the moon 🌙',
      'You see a rainbow 🌈',
      'You see the sun ☀️',
      'Everything is blue 🔵',
    ],
    'You see stars and the moon 🌙',
    'At night the stars and moon light up the sky! ✨',
  ),
];

const ifThenMedium: Unidentified<IfThenQuestion>[] = [
  ift(
    'If all cats are animals, and Fluffy is a cat...',
    'If Fluffy is in the "cats" group, what bigger group does that put Fluffy in? 🐾',
    ['Fluffy is an animal 🐾', 'Fluffy is a dog 🐶', 'Fluffy can fly ✈️', 'Fluffy is a plant 🌱'],
    'Fluffy is an animal 🐾',
    'If ALL cats are animals and Fluffy is a cat, then Fluffy must be an animal! 🧠',
  ),
  ift(
    'If all fish live in water, and a goldfish is a fish...',
    'A goldfish belongs to the "fish" group: where do all fish live? 💧',
    [
      'It lives in water 💧',
      'It lives on land 🏔️',
      'It lives in trees 🌳',
      'It lives in the sky ☁️',
    ],
    'It lives in water 💧',
    'All fish live in water, and goldfish are fish! 🐟',
  ),
  ift(
    'If today is Monday, then tomorrow is...',
    'Think about the days of the week in order! 📅',
    ['Tuesday', 'Wednesday', 'Sunday', 'Saturday'],
    'Tuesday',
    'The day after Monday is always Tuesday! 📅',
  ),
  ift(
    'If you score more goals, your team...',
    'In football, goals help your team do what? ⚽',
    [
      'Is more likely to win 🏆',
      'Gets fewer points 📉',
      'Must stop playing ⏹️',
      'Changes colour 🎨',
    ],
    'Is more likely to win 🏆',
    'More goals = better chance of winning! ⚽',
  ),
  ift(
    'If all birds have feathers, and a robin is a bird...',
    'What do ALL birds have? A robin is one of them! 🪶',
    [
      'A robin has feathers 🪶',
      'A robin has scales 🐍',
      'A robin has fur 🐻',
      'A robin has none of these ❌',
    ],
    'A robin has feathers 🪶',
    'All birds have feathers, so robins do too! 🐦',
  ),
  ift(
    'If 3 + 4 = 7, then 7 - 4 = ...',
    'Addition and subtraction are like going forward and backward! 🔢',
    ['3', '4', '5', '11'],
    '3',
    'Addition and subtraction are opposites! 7 - 4 = 3! 🔢',
  ),
  ift(
    'If the temperature drops below 0°C...',
    'What happens to water when it gets very, very cold? 🧊',
    [
      'Water can freeze into ice ❄️',
      'It gets hotter 🔥',
      'Trees grow faster 🌳',
      'The sky turns green 💚',
    ],
    'Water can freeze into ice ❄️',
    'Below zero, water freezes into solid ice! 🧊',
  ),
  ift(
    'If Sam is taller than Tom, and Tom is taller than Ben...',
    'Try to picture them standing in a line from shortest to tallest! 📏',
    [
      'Sam is taller than Ben',
      'Ben is the tallest',
      'They are all the same height',
      'Tom is the shortest',
    ],
    'Sam is taller than Ben',
    'If Sam > Tom > Ben, then Sam must be taller than Ben! 📏',
  ),
  ift(
    'If mammals breathe air, and dolphins are mammals...',
    'Dolphins are in the "mammals" group: what does that mean they do? 🐬',
    [
      'Dolphins breathe air',
      'Dolphins breathe water',
      "Dolphins don't breathe",
      'Dolphins are fish',
    ],
    'Dolphins breathe air',
    'Dolphins are mammals so they must breathe air! 🐬',
  ),
  ift(
    'If every square has 4 equal sides, then a shape with 5 sides is...',
    'Count the sides! Does it match what a square has? 📐',
    ['Not a square ❌', 'A square ✅', 'A circle ⭕', 'A triangle 🔺'],
    'Not a square ❌',
    "5 sides means it can't be a square: it might be a pentagon! ⬠",
  ),
  ift(
    'If you eat too many sweets without brushing...',
    "Sugar and teeth don't mix well! What can happen? 🦷",
    [
      'You might get cavities 🦷',
      'Your teeth get stronger 💪',
      'You grow taller 📏',
      'Nothing happens 🤷',
    ],
    'You might get cavities 🦷',
    'Sugar can cause tooth decay: always brush! 🪥',
  ),
  ift(
    'If all roses are flowers, and all flowers are plants...',
    'Follow the chain: roses → flowers → ? 🌹',
    [
      'All roses are plants 🌹',
      'No roses are plants ❌',
      'Some roses are rocks 🪨',
      'Roses are animals 🐾',
    ],
    'All roses are plants 🌹',
    'Roses → flowers → plants. So roses are plants! 🌱',
  ),
  ift(
    'If it takes 2 hours to bake a cake, and you start at 3pm...',
    'Add the baking time to the start time! ⏰',
    ["It's ready at 5pm ⏰", "It's ready at 4pm ⏰", "It's ready at 6pm ⏰", "It's never ready 😢"],
    "It's ready at 5pm ⏰",
    '3pm + 2 hours = 5pm! Your cake is done! 🎂',
  ),
  ift(
    'If you need 3 apples for a pie, and you have 2...',
    'How many more do you need? Take away what you have! 🍎',
    [
      'You need 1 more apple 🍎',
      'You have enough ✅',
      'You need 3 more 🍎🍎🍎',
      'You should make soup 🍲',
    ],
    'You need 1 more apple 🍎',
    '3 needed minus 2 you have = 1 more to get! 🧮',
  ),
  ift(
    'If no reptiles have fur, and snakes are reptiles...',
    'Snakes are in the "reptiles" group: what do reptiles NOT have? 🐍',
    ["Snakes don't have fur", 'Snakes have lots of fur', 'Snakes are mammals', 'Snakes are birds'],
    "Snakes don't have fur",
    "No reptiles have fur, so snakes don't either: they have scales! 🐍",
  ),
  ift(
    'If the pattern is 2, 4, 6, 8, the next number is...',
    'What are you adding each time? Look at the gaps! 🔢',
    ['10', '9', '11', '12'],
    '10',
    'We add 2 each time: 8 + 2 = 10! 🔢',
  ),
  ift(
    'If Anna has more stickers than Bob, and Bob has more than Claire...',
    'Put them in order: who has the most? ⭐',
    [
      'Anna has the most stickers ⭐',
      'Claire has the most ⭐',
      'Bob has the most ⭐',
      'They all have the same ✅',
    ],
    'Anna has the most stickers ⭐',
    'Anna > Bob > Claire, so Anna has the most! 🏆',
  ),
  ift(
    'If all triangles have 3 sides, then a 3-sided shape is...',
    'Which shape has exactly 3 sides? The clue is in the name! 🔺',
    ['A triangle 🔺', 'A square ⬛', 'A circle ⭕', 'A hexagon ⬡'],
    'A triangle 🔺',
    '3 sides = triangle! The name even has "tri" (three) in it! 🔺',
  ),
  ift(
    'If you double 5, you get...',
    'Doubling means having two groups of 5! ✖️',
    ['10', '7', '15', '25'],
    '10',
    '5 × 2 = 10! Doubling means multiplying by 2! ✖️',
  ),
  ift(
    'If every child in class has a pencil, and Liam is in the class...',
    'Liam is one of the children, so what does he have? ✏️',
    ['Liam has a pencil ✏️', 'Liam has a pen 🖊️', 'Liam has nothing ❌', 'Liam is not in class 🚫'],
    'Liam has a pencil ✏️',
    'Every child has one, and Liam is a child in the class! ✏️',
  ),
  ift(
    'If all vehicles have wheels, and a bicycle is a vehicle...',
    'Bicycles are in the "vehicles" group: what do all vehicles have? 🚲',
    [
      'A bicycle has wheels 🚲',
      'A bicycle flies ✈️',
      'A bicycle swims 🏊',
      'A bicycle has legs 🦵',
    ],
    'A bicycle has wheels 🚲',
    'All vehicles have wheels, so bicycles do too! 🚲',
  ),
  ift(
    'If you save AED 5 every week for 4 weeks...',
    'Add up the savings: 5 + 5 + 5 + 5! 💰',
    ['You have AED 20 💰', 'You have AED 15 💰', 'You have AED 5 💰', 'You have AED 40 💰'],
    'You have AED 20 💰',
    '5 × 4 = 20! Saving adds up! 🏦',
  ),
  ift(
    'If a recipe needs 3 eggs per cake, and you want 2 cakes...',
    'Two cakes means you need the eggs twice! 🥚',
    ['You need 6 eggs 🥚', 'You need 3 eggs 🥚', 'You need 5 eggs 🥚', 'You need 9 eggs 🥚'],
    'You need 6 eggs 🥚',
    '3 eggs × 2 cakes = 6 eggs total! 🎂',
  ),
  ift(
    'If red things are round, and a fire truck is red...',
    'Careful! Think about whether ALL red things are truly round! 🤔',
    [
      'A fire truck is round? Not necessarily!',
      'A fire truck is definitely round',
      "Fire trucks can't be red",
      'Red things are always trucks',
    ],
    'A fire truck is round? Not necessarily!',
    'This is tricky! Not all red things are actually round: the rule might be wrong! 🤔',
  ),
  ift(
    'If there are 12 months, and we are in the 6th month...',
    'What is 6 out of 12? Think about fractions! 📅',
    [
      'Half the year has passed',
      'The year just started',
      'The year is almost over',
      "It's the first month",
    ],
    'Half the year has passed',
    '6 out of 12 months = exactly half! 📅',
  ),
  ift(
    'If all birds can sing, and a parrot is a bird...',
    'If something is true for ALL birds, is it true for one particular bird? 🦜',
    ['A parrot can sing 🎵', "A parrot can't sing", 'A parrot is a fish', "Parrots don't exist"],
    'A parrot can sing 🎵',
    'If all birds can sing and parrots are birds, then parrots can sing! 🦜',
  ),
  ift(
    'If you walk 100 steps north, then 100 steps south...',
    'Think about going one way and then going back the same amount! 🧭',
    [
      "You're back where you started",
      "You're 200 steps away",
      "You're 100 steps north",
      "You're lost",
    ],
    "You're back where you started",
    'Going north then the same distance south brings you right back! 🧭',
  ),
  ift(
    "If ice cream melts when warm, and it's a hot summer day...",
    'Hot weather affects frozen treats! What happens? 🍦',
    [
      'The ice cream will melt 🍦',
      'The ice cream will freeze',
      'Nothing will happen',
      'It will rain',
    ],
    'The ice cream will melt 🍦',
    'Heat melts ice cream: eat it fast on hot days! ☀️',
  ),
  ift(
    'If 10 children share 30 sweets equally...',
    'Divide the total sweets by the number of children! 🍬',
    [
      'Each child gets 3 🍬',
      'Each child gets 10 🍬',
      'Each child gets 30 🍬',
      "There aren't enough 😢",
    ],
    'Each child gets 3 🍬',
    '30 ÷ 10 = 3 sweets each! Fair sharing! 🤝',
  ),
];

const ifThenHard: Unidentified<IfThenQuestion>[] = [
  ift(
    'If no birds are reptiles, and all eagles are birds...',
    'Eagles are birds, and birds are NOT in the reptile group! 🦅',
    [
      'No eagles are reptiles',
      'All eagles are reptiles',
      'Some eagles are reptiles',
      'Eagles are fish',
    ],
    'No eagles are reptiles',
    "Birds and reptiles are different! Eagles are birds, so they're not reptiles! 🦅",
  ),
  ift(
    'If A is bigger than B, and C is bigger than A...',
    'Line them up: B, then A, then C. Who is on top? 📏',
    ['C is the biggest', 'A is the biggest', 'B is the biggest', "They're all equal"],
    'C is the biggest',
    'C > A > B, so C is the biggest! 📏',
  ),
  ift(
    'If all multiples of 4 are even, and 12 is a multiple of 4...',
    '12 = 4 × 3. What is special about multiples of 4? 🧮',
    ['12 is even ✅', '12 is odd ❌', '12 is prime 🔢', '12 is not a number ❓'],
    '12 is even ✅',
    'Multiples of 4 are always even, and 12 = 4 × 3! 🧮',
  ),
  ift(
    'If it is NOT raining, then the ground is NOT wet (from rain). The ground IS wet...',
    'Think about it backwards: if the ground is wet, what could cause it? 🤔',
    [
      'It might be raining 🌧️',
      'It is definitely not raining ☀️',
      'The ground is dry 🏜️',
      'It is snowing ❄️',
    ],
    'It might be raining 🌧️',
    'If the ground is wet, rain could be the cause! (Or a sprinkler!) 🤔',
  ),
  ift(
    'If half of 20 is 10, then half of 10 is...',
    'Keep halving! What is 10 divided by 2? ➗',
    ['5', '10', '20', '15'],
    '5',
    'Half means dividing by 2: 10 ÷ 2 = 5! ➗',
  ),
  ift(
    'If the sum of two numbers is 15, and one number is 8...',
    'What do you add to 8 to get 15? 🧮',
    ['The other is 7', 'The other is 8', 'The other is 6', 'The other is 9'],
    'The other is 7',
    '15 - 8 = 7! The two numbers are 8 and 7! 🧮',
  ),
  ift(
    'If all planets orbit the Sun, and Mars is a planet...',
    'Mars is in the "planets" group: what do all planets do? ☀️',
    [
      'Mars orbits the Sun ☀️',
      'Mars orbits the Moon 🌙',
      "Mars doesn't move 🛑",
      'Mars is a star ⭐',
    ],
    'Mars orbits the Sun ☀️',
    'All planets orbit the Sun, including Mars! 🪐',
  ),
  ift(
    'If something is a mammal, it does NOT lay eggs (usually). A chicken lays eggs...',
    "Mammals don't lay eggs. Chickens DO lay eggs, so what does that tell you? 🐔",
    [
      'A chicken is not a mammal',
      'A chicken is a mammal',
      "Chickens don't lay eggs",
      'All birds are mammals',
    ],
    'A chicken is not a mammal',
    'Egg-laying animals are usually not mammals! Chickens are birds! 🐔',
  ),
  ift(
    'If the day before yesterday was Wednesday, today is...',
    'Count forward from Wednesday: Thursday, then one more day! 📅',
    ['Friday', 'Thursday', 'Saturday', 'Tuesday'],
    'Friday',
    'Wednesday + 1 day = Thursday (yesterday), + 1 more = Friday (today)! 📅',
  ),
  ift(
    'If 5 × 6 = 30, then 30 ÷ 5 = ...',
    'Multiplication and division undo each other! ➗',
    ['6', '5', '25', '35'],
    '6',
    'Multiplication and division are opposites! 30 ÷ 5 = 6! ➗',
  ),
  ift(
    'If all squares are rectangles, but not all rectangles are squares...',
    'Squares are special rectangles, but can a rectangle be different from a square? 📐',
    [
      'A rectangle might not be a square',
      'All rectangles are squares',
      'Squares have 5 sides',
      'Rectangles are circles',
    ],
    'A rectangle might not be a square',
    'Squares are special rectangles with all sides equal! But rectangles can have different side lengths! 📐',
  ),
  ift(
    'If Amy is not older than Ben, and Ben is not older than Amy...',
    'If neither is older, what does that make them? 🎂',
    ['Amy and Ben are the same age', 'Amy is older', 'Ben is older', "We can't tell"],
    'Amy and Ben are the same age',
    'If neither is older than the other, they must be the same age! 🎂',
  ),
  ift(
    'If you need to be 10 to ride the big slide, and you are 8...',
    'Compare: are you old enough? 8 vs 10! 🎢',
    ['You cannot ride yet', 'You can ride now', 'You need to be 7', 'The slide is broken'],
    'You cannot ride yet',
    "8 is less than 10, so you'll have to wait 2 more years! 🎢",
  ),
  ift(
    'If the perimeter of a square is 20cm, each side is...',
    'A square has 4 equal sides. Divide the total by 4! 📐',
    ['5cm', '4cm', '10cm', '20cm'],
    '5cm',
    'A square has 4 equal sides: 20 ÷ 4 = 5cm each! 📐',
  ),
  ift(
    'If mixing yellow and blue makes green, and you have yellow and blue...',
    'You have both colours needed: what can you make? 🎨',
    [
      'You can make green 💚',
      'You can make red ❤️',
      'You can make purple 💜',
      "You can't mix them ❌",
    ],
    'You can make green 💚',
    'Yellow + blue = green! Try it with paint! 🎨',
  ),
  ift(
    'If every even number is divisible by 2, and 14 is even...',
    'Even numbers always split cleanly in half! 🔢',
    ['14 is divisible by 2', '14 is odd', '14 is prime', '14 ÷ 2 has a remainder'],
    '14 is divisible by 2',
    '14 ÷ 2 = 7 with no remainder! Even numbers always divide by 2! 🔢',
  ),
  ift(
    'If point A is north of B, and B is north of C...',
    'Imagine a map: who is highest up? 🗺️',
    [
      'A is the most northern',
      'C is the most northern',
      'B is the most northern',
      'They are on the same spot',
    ],
    'A is the most northern',
    'A is above B which is above C on a map! 🗺️',
  ),
  ift(
    'If Sarah has 12 sweets and shares equally with 3 friends (4 people total)...',
    'Be careful! Count Sarah too: 4 people total share 12 sweets! 🍬',
    [
      'Each person gets 3 sweets',
      'Each person gets 4 sweets',
      'Each person gets 6 sweets',
      'Each person gets 12 sweets',
    ],
    'Each person gets 3 sweets',
    '12 sweets ÷ 4 people = 3 each! Sharing is caring! 🍬',
  ),
  ift(
    'If an animal has no legs and no fur, it is probably...',
    'Think of animals without legs AND without fur! 🐍',
    ['A fish or a snake 🐟', 'A dog 🐶', 'A bird 🐦', 'A cat 🐱'],
    'A fish or a snake 🐟',
    'Fish and snakes have no legs and no fur! 🐍',
  ),
  ift(
    'If it takes 5 minutes to walk 1 block, how long for 4 blocks?',
    'Multiply the time per block by the number of blocks! ⏱️',
    ['20 minutes ⏱️', '5 minutes ⏱️', '10 minutes ⏱️', '9 minutes ⏱️'],
    '20 minutes ⏱️',
    '5 minutes × 4 blocks = 20 minutes! 🚶',
  ),
  ift(
    'If the opposite of "up" is "down", then the opposite of "hot" is...',
    'Think about word pairs that are complete opposites! 🔄',
    ['Cold ❄️', 'Warm 🌡️', 'Big 📏', 'Fast 🏃'],
    'Cold ❄️',
    'Hot and cold are opposites, just like up and down! 🔄',
  ),
  ift(
    'If a number is divisible by both 2 and 3, it is divisible by...',
    'What do you get when you multiply 2 × 3? 🧮',
    ['6', '5', '8', '4'],
    '6',
    '2 × 3 = 6, so if it divides by both 2 and 3, it divides by 6! 🧮',
  ),
  ift(
    'If you face north and turn 180 degrees...',
    '180 degrees is a half turn: you end up facing the opposite way! 🧭',
    ['You face south', 'You face east', 'You face west', 'You face north'],
    'You face south',
    '180 degrees is a half turn: north becomes south! 🧭',
  ),
  ift(
    'If 2 painters paint a room in 6 hours, 4 painters could paint it in about...',
    'Double the workers means half the time! 🎨',
    ['3 hours', '6 hours', '12 hours', '2 hours'],
    '3 hours',
    'Double the painters = half the time! 4 painters work twice as fast! 🎨',
  ),
  ift(
    'If a cube has 6 faces and each face is a square, a triangular prism has...',
    'Count: 2 triangle faces on the ends + 3 rectangle faces around! 📐',
    ['5 faces', '4 faces', '6 faces', '3 faces'],
    '5 faces',
    'A triangular prism has 2 triangle faces + 3 rectangle faces = 5! 📐',
  ),
  ift(
    "If it's 3:45pm and you wait 30 minutes...",
    'Add 30 minutes to 3:45: what time do you get? ⏰',
    ["It's 4:15pm ⏰", "It's 4:45pm ⏰", "It's 3:15pm ⏰", "It's 4:00pm ⏰"],
    "It's 4:15pm ⏰",
    '3:45 + 30 minutes = 4:15! ⏰',
  ),
  ift(
    'If all even numbers end in 0, 2, 4, 6, or 8, then 137 is...',
    'Look at the last digit: what does 137 end in? 🔢',
    ['Odd', 'Even', 'Neither', 'Both'],
    'Odd',
    "137 ends in 7, which is not in the list, so it's odd! 🔢",
  ),
  ift(
    'If speed = distance ÷ time, and you travel 100km in 2 hours...',
    'Divide the distance by the time! 🚗',
    [
      'Your speed is 50 km/h',
      'Your speed is 200 km/h',
      'Your speed is 100 km/h',
      'Your speed is 25 km/h',
    ],
    'Your speed is 50 km/h',
    '100 ÷ 2 = 50 km/h! 🚗',
  ),
  ift(
    'If today is the 15th and your birthday is in 10 days...',
    'Add 10 to 15! 🎂',
    [
      'Your birthday is on the 25th 🎂',
      'Your birthday is on the 5th 🎂',
      'Your birthday is on the 20th 🎂',
      'Your birthday is on the 10th 🎂',
    ],
    'Your birthday is on the 25th 🎂',
    '15 + 10 = 25! Happy birthday in 10 days! 🎉',
  ),
];

// ═══════════════════════════════════════════════════════════════════════════════
// SORTING
// ═══════════════════════════════════════════════════════════════════════════════

const sortingEasy: Unidentified<SortingQuestion>[] = [
  srt(
    '🍎 Apple',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🍏 Fruits',
    'Apples are sweet fruits that grow on trees! 🍎',
  ),
  srt(
    '🥕 Carrot',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🥦 Vegetables',
    'Carrots are crunchy vegetables that grow in the ground! 🥕',
  ),
  srt(
    '🐶 Dog',
    ['🐾 Animals', '🏠 Objects'],
    '🐾 Animals',
    'Dogs are living animals: our best friends! 🐕',
  ),
  srt(
    '🪑 Chair',
    ['🐾 Animals', '🏠 Objects'],
    '🏠 Objects',
    'A chair is an object you sit on! 🪑',
  ),
  srt(
    '🍌 Banana',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🍏 Fruits',
    'Bananas are yummy yellow fruits! 🍌',
  ),
  srt('🐱 Cat', ['🐾 Animals', '🏠 Objects'], '🐾 Animals', 'Cats are furry animals that purr! 🐱'),
  srt('📚 Book', ['🐾 Animals', '🏠 Objects'], '🏠 Objects', 'A book is an object you read! 📖'),
  srt(
    '🥦 Broccoli',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🥦 Vegetables',
    'Broccoli is a green vegetable that looks like tiny trees! 🥦',
  ),
  srt(
    '🐟 Fish',
    ['🐾 Animals', '🏠 Objects'],
    '🐾 Animals',
    'Fish are animals that live in water! 🐟',
  ),
  srt(
    '🍇 Grapes',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🍏 Fruits',
    'Grapes are small round fruits that grow in bunches! 🍇',
  ),
  srt(
    '🚗 Car',
    ['🐾 Animals', '🏠 Objects'],
    '🏠 Objects',
    'A car is a machine that takes us places! 🚗',
  ),
  srt(
    '🥒 Cucumber',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🥦 Vegetables',
    'Cucumbers are cool, crunchy vegetables! 🥒',
  ),
  srt(
    '🐰 Rabbit',
    ['🐾 Animals', '🏠 Objects'],
    '🐾 Animals',
    'Rabbits are fluffy animals that hop! 🐰',
  ),
  srt(
    '🍊 Orange',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🍏 Fruits',
    'Oranges are juicy citrus fruits! 🍊',
  ),
  srt(
    '⚽ Football',
    ['🐾 Animals', '🏠 Objects'],
    '🏠 Objects',
    'A football is a ball you kick around! ⚽',
  ),
  srt(
    '🌽 Corn',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🥦 Vegetables',
    'Corn is a vegetable that grows on tall stalks! 🌽',
  ),
  srt(
    '🐦 Bird',
    ['🐾 Animals', '🏠 Objects'],
    '🐾 Animals',
    'Birds are animals with wings and feathers! 🐦',
  ),
  srt(
    '🍓 Strawberry',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🍏 Fruits',
    'Strawberries are sweet red fruits! 🍓',
  ),
  srt(
    '🎸 Guitar',
    ['🐾 Animals', '🏠 Objects'],
    '🏠 Objects',
    'A guitar is a musical instrument! 🎸',
  ),
  srt(
    '🧅 Onion',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🥦 Vegetables',
    'Onions are vegetables that can make you cry! 🧅',
  ),
  srt(
    '🐸 Frog',
    ['🐾 Animals', '🏠 Objects'],
    '🐾 Animals',
    'Frogs are amphibians: they live in water and on land! 🐸',
  ),
  srt(
    '🍑 Peach',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🍏 Fruits',
    'Peaches are soft, fuzzy fruits! 🍑',
  ),
  srt(
    '🎒 Backpack',
    ['🐾 Animals', '🏠 Objects'],
    '🏠 Objects',
    'A backpack is something you wear to carry things! 🎒',
  ),
  srt(
    '🥬 Lettuce',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🥦 Vegetables',
    'Lettuce is a green leafy vegetable for salads! 🥗',
  ),
  srt('🐻 Bear', ['🐾 Animals', '🏠 Objects'], '🐾 Animals', 'Bears are big, furry animals! 🐻'),
  srt(
    '🍍 Pineapple',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🍏 Fruits',
    'Pineapples are spiky tropical fruits! 🍍',
  ),
  srt('🔑 Key', ['🐾 Animals', '🏠 Objects'], '🏠 Objects', 'A key opens doors and locks! 🔑'),
  srt(
    '🥔 Potato',
    ['🍏 Fruits', '🥦 Vegetables'],
    '🥦 Vegetables',
    'Potatoes are vegetables that grow underground! 🥔',
  ),
  srt(
    '🦊 Fox',
    ['🐾 Animals', '🏠 Objects'],
    '🐾 Animals',
    'Foxes are clever animals that live in the wild! 🦊',
  ),
];

const sortingMedium: Unidentified<SortingQuestion>[] = [
  srt(
    '🐄 Cow',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    'Cows live on farms on land! 🐄',
  ),
  srt(
    '🐬 Dolphin',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🌊 Sea Animals',
    'Dolphins live and swim in the ocean! 🐬',
  ),
  srt(
    '🦈 Shark',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🌊 Sea Animals',
    'Sharks are ocean predators! 🦈',
  ),
  srt(
    '🐘 Elephant',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    "Elephants walk on land: they're the biggest land animal! 🐘",
  ),
  srt(
    '☕ Hot Chocolate',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '🔥 Hot Things',
    'Hot chocolate is a warm drink to keep you cozy! ☕',
  ),
  srt(
    '🍦 Ice Cream',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '❄️ Cold Things',
    'Ice cream is frozen and cold: perfect for summer! 🍦',
  ),
  srt(
    '🌋 Volcano',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '🔥 Hot Things',
    'Volcanoes have hot lava inside! 🌋',
  ),
  srt(
    '❄️ Snowflake',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '❄️ Cold Things',
    'Snowflakes are frozen ice crystals: very cold! ❄️',
  ),
  srt(
    '🐎 Horse',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    'Horses gallop across fields on land! 🐎',
  ),
  srt(
    '🐙 Octopus',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🌊 Sea Animals',
    'Octopuses live deep in the ocean! 🐙',
  ),
  srt(
    '🍲 Soup',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '🔥 Hot Things',
    'Soup is served hot to warm you up! 🍲',
  ),
  srt(
    '🧊 Ice Cube',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '❄️ Cold Things',
    'Ice cubes are frozen water: super cold! 🧊',
  ),
  srt(
    '🐍 Snake',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    'Most snakes slither on land! 🐍',
  ),
  srt(
    '🐋 Whale',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🌊 Sea Animals',
    'Whales are the biggest sea animals! 🐋',
  ),
  srt(
    '🔥 Campfire',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '🔥 Hot Things',
    "Campfires are very hot: don't get too close! 🏕️",
  ),
  srt(
    '🍧 Frozen Yogurt',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '❄️ Cold Things',
    'Frozen yogurt is served cold like ice cream! 🍧',
  ),
  srt(
    '🐊 Crocodile',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    'Crocodiles live in rivers and on riverbanks! 🐊',
  ),
  srt(
    '🦀 Crab',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🌊 Sea Animals',
    'Crabs live in the ocean and on beaches! 🦀',
  ),
  srt(
    '☀️ The Sun',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '🔥 Hot Things',
    'The Sun is the hottest thing in our solar system! ☀️',
  ),
  srt(
    '🥶 North Pole',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '❄️ Cold Things',
    'The North Pole is one of the coldest places on Earth! 🧊',
  ),
  srt(
    '🐺 Wolf',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    'Wolves roam forests and mountains on land! 🐺',
  ),
  srt(
    '🐢 Sea Turtle',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🌊 Sea Animals',
    'Sea turtles spend most of their lives in the ocean! 🐢',
  ),
  srt(
    '🫖 Hot Tea',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '🔥 Hot Things',
    'Tea is brewed with hot water! ☕',
  ),
  srt(
    '🐻‍❄️ Polar Bear',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    'Polar bears walk on ice and land: they swim but live on shore! 🐻‍❄️',
  ),
  srt(
    '🥤 Iced Lemonade',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '❄️ Cold Things',
    'Iced lemonade is served cold with ice cubes! 🍋',
  ),
  srt(
    '🦭 Seal',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🌊 Sea Animals',
    'Seals spend most of their time in the ocean! 🦭',
  ),
  srt(
    '🌡️ Desert Sand',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '🔥 Hot Things',
    'Desert sand gets extremely hot under the blazing sun! 🏜️',
  ),
  srt(
    '🐆 Leopard',
    ['🏡 Land Animals', '🌊 Sea Animals'],
    '🏡 Land Animals',
    'Leopards are big cats that live on land! 🐆',
  ),
  srt(
    '🧊 Glacier',
    ['🔥 Hot Things', '❄️ Cold Things'],
    '❄️ Cold Things',
    'Glaciers are massive rivers of ice: extremely cold! 🏔️',
  ),
];

const sortingHard: Unidentified<SortingQuestion>[] = [
  srt(
    '🪵 Wood',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Wood is lighter than water, so it floats! 🪵',
  ),
  srt(
    '🪨 Rock',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '⬇️ Things That Sink',
    'Rocks are heavy and dense: they sink! 🪨',
  ),
  srt(
    '🌸 Flower',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Flowers are alive: they grow, drink water, and bloom! 🌺',
  ),
  srt(
    '🪑 Chair',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🔩 Non-Living Things',
    "A chair is made of materials but it's not alive! 🪑",
  ),
  srt(
    '🧽 Sponge',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Sponges are full of air pockets and float on water! 🧽',
  ),
  srt(
    '🔑 Metal Key',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '⬇️ Things That Sink',
    'Metal is heavy and dense: it sinks! 🔑',
  ),
  srt(
    '🐛 Caterpillar',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Caterpillars are alive: they eat, move, and become butterflies! 🦋',
  ),
  srt(
    '📱 Phone',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🔩 Non-Living Things',
    'Phones are machines made by people: not alive! 📱',
  ),
  srt(
    '🏐 Beach Ball',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Beach balls are full of air and float! 🏐',
  ),
  srt(
    '🪙 Coin',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '⬇️ Things That Sink',
    'Coins are metal and sink to the bottom! 🪙',
  ),
  srt(
    '🌳 Tree',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Trees are alive: they grow, breathe, and provide shade! 🌳',
  ),
  srt(
    '🧱 Brick',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🔩 Non-Living Things',
    'Bricks are made from clay: not alive! 🧱',
  ),
  srt(
    '🍂 Leaf',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Leaves are light and flat: they float on water! 🍃',
  ),
  srt(
    '⚓ Anchor',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '⬇️ Things That Sink',
    "Anchors are made to be heavy and sink: that's their job! ⚓",
  ),
  srt(
    '🐞 Ladybug',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Ladybugs are tiny living insects! 🐞',
  ),
  srt(
    '💎 Diamond',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🔩 Non-Living Things',
    'Diamonds are beautiful minerals, but not alive! 💎',
  ),
  srt(
    '🧸 Teddy Bear',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🔩 Non-Living Things',
    "Teddy bears are cute but they're toys, not alive! 🧸",
  ),
  srt(
    '🌱 Seedling',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Seedlings are baby plants: very much alive! 🌱',
  ),
  srt(
    '🎈 Balloon',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Balloons with air inside are light and float! 🎈',
  ),
  srt(
    '🔨 Hammer',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '⬇️ Things That Sink',
    'Hammers are heavy metal tools: they sink! 🔨',
  ),
  srt(
    '🦠 Bacteria',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Bacteria are tiny living organisms: too small to see! 🔬',
  ),
  srt(
    '🧲 Magnet',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🔩 Non-Living Things',
    "Magnets are metal objects: they attract iron but aren't alive! 🧲",
  ),
  srt(
    '🪶 Feather',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Feathers are super light and float on water! 🪶',
  ),
  srt(
    '🔩 Bolt',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '⬇️ Things That Sink',
    'Metal bolts are heavy and sink straight down! 🔩',
  ),
  srt(
    '🐝 Bee',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Bees are living insects that pollinate flowers! 🐝',
  ),
  srt(
    '🧱 Pebble',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '⬇️ Things That Sink',
    'Small stones are dense and sink to the bottom! 🪨',
  ),
  srt(
    '🍄 Mushroom',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🌿 Living Things',
    'Mushrooms are living fungi: they grow and reproduce! 🍄',
  ),
  srt(
    '🛟 Life Ring',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Life rings are designed to float and save lives! 🛟',
  ),
  srt(
    '💻 Laptop',
    ['🌿 Living Things', '🔩 Non-Living Things'],
    '🔩 Non-Living Things',
    'Laptops are electronic devices: smart but not alive! 💻',
  ),
  srt(
    '🏀 Basketball',
    ['🏊 Things That Float', '⬇️ Things That Sink'],
    '🏊 Things That Float',
    'Basketballs are filled with air and float on water! 🏀',
  ),
];

// ═══════════════════════════════════════════════════════════════════════════════
// BANK EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Stamp stable, scoped IDs onto a builder array.
 * Format: `${gameType}-${difficulty}-${1-based-index}`: stable against
 * reorders and insertions within a combo. A future change to position 3 only
 * shifts ids for that combo, never another, and the grader always looks up by
 * id within the (gameType, difficulty) bank.
 */
function tagIds<T extends LogicQuestion>(
  gt: LogicGameType,
  diff: LogicDifficulty,
  arr: Unidentified<T>[],
): T[] {
  return arr.map((q, i) => ({ ...q, id: `${gt}-${diff}-${i + 1}` }) as T);
}

const BANK: Record<LogicGameType, Record<LogicDifficulty, LogicQuestion[]>> = {
  truefalse: {
    easy: tagIds('truefalse', 'easy', trueFalseEasy),
    medium: tagIds('truefalse', 'medium', trueFalseMedium),
    hard: tagIds('truefalse', 'hard', trueFalseHard),
  },
  patterns: {
    easy: tagIds('patterns', 'easy', patternsEasy),
    medium: tagIds('patterns', 'medium', patternsMedium),
    hard: tagIds('patterns', 'hard', patternsHard),
  },
  oddoneout: {
    easy: tagIds('oddoneout', 'easy', oddOneOutEasy),
    medium: tagIds('oddoneout', 'medium', oddOneOutMedium),
    hard: tagIds('oddoneout', 'hard', oddOneOutHard),
  },
  ifthen: {
    easy: tagIds('ifthen', 'easy', ifThenEasy),
    medium: tagIds('ifthen', 'medium', ifThenMedium),
    hard: tagIds('ifthen', 'hard', ifThenHard),
  },
  sorting: {
    easy: tagIds('sorting', 'easy', sortingEasy),
    medium: tagIds('sorting', 'medium', sortingMedium),
    hard: tagIds('sorting', 'hard', sortingHard),
  },
};

/**
 * Lookup by (gameType, difficulty). Throws for unknown combos: callers should
 * validate inputs with isLogicGameType / isLogicDifficulty first.
 */
export function getRawQuestions(
  gameType: LogicGameType,
  difficulty: LogicDifficulty,
): LogicQuestion[] {
  return BANK[gameType][difficulty];
}

/** Type guard for gameType. */
export function isLogicGameType(v: unknown): v is LogicGameType {
  return typeof v === 'string' && (LOGIC_GAME_TYPES as readonly string[]).includes(v);
}

/** Type guard for difficulty. */
export function isLogicDifficulty(v: unknown): v is LogicDifficulty {
  return typeof v === 'string' && (LOGIC_DIFFICULTIES as readonly string[]).includes(v);
}

/**
 * Client-facing accessor. Returns questions for (gameType, difficulty) with the
 * correct answer stripped, mirroring how learn-questions.ts exposes PublicQuestion.
 */
export function getLogicQuestions(
  gameType: LogicGameType,
  difficulty: LogicDifficulty,
): PublicLogicQuestion[] {
  return getRawQuestions(gameType, difficulty).map((q) => {
    // Strip the server-only `answer` field; everything else is safe for the client.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { answer: _answer, ...rest } = q as LogicQuestion & { answer: unknown };
    return rest as PublicLogicQuestion;
  });
}

/**
 * Verify a submitted answer against the bank. Returns { correct, correctAnswer,
 * explanation } or null if the questionId is unknown.
 */
export function gradeLogicAnswer(
  gameType: LogicGameType,
  difficulty: LogicDifficulty,
  questionId: string,
  submittedAnswer: string | boolean,
): { correct: boolean; correctAnswer: string | boolean; explanation: string } | null {
  const questions = getRawQuestions(gameType, difficulty);
  const q = questions.find((x) => x.id === questionId);
  if (!q) return null;

  const correct = q.answer === submittedAnswer || String(q.answer) === String(submittedAnswer);
  return {
    correct,
    correctAnswer: q.answer,
    explanation: q.explanation,
  };
}

/** Count of questions per (gameType, difficulty): useful for testing. */
export function getQuestionCounts(): Record<LogicGameType, Record<LogicDifficulty, number>> {
  const result = {} as Record<LogicGameType, Record<LogicDifficulty, number>>;
  for (const gt of LOGIC_GAME_TYPES) {
    result[gt] = {} as Record<LogicDifficulty, number>;
    for (const d of LOGIC_DIFFICULTIES) {
      result[gt][d] = BANK[gt][d].length;
    }
  }
  return result;
}
