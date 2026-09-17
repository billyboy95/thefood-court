import { randsToCents } from '../lib/money.js';

export const categories = [
  { id: 'all', label: 'All' },
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch pots' },
  { id: 'grill', label: 'Grill' },
  { id: 'sides', label: 'Sides' },
  { id: 'drinks', label: 'Drinks' },
];

/**
 * Board prices from the published Food Court menu (ZAR).
 * specialOn: JS weekday (0=Sun … 6=Sat) when the item is the daily special.
 */
export const menuItems = [
  {
    id: 'eggs-toast',
    category: 'breakfast',
    name: 'Eggs on toast',
    description: 'Fried eggs on toast, campus breakfast.',
    priceCents: randsToCents(38),
    image: 'assets/food/eggs.jpg',
    popular: true,
  },
  {
    id: 'breakfast-roll',
    category: 'breakfast',
    name: 'Breakfast roll',
    description: 'Filled roll to grab between lectures.',
    priceCents: randsToCents(45),
    image: 'assets/food/breakfast-roll.jpg',
  },
  {
    id: 'full-brunch',
    category: 'breakfast',
    name: 'Full brunch',
    description: 'Eggs, wors and chips. Saturday kitchen.',
    priceCents: randsToCents(89),
    image: 'assets/food/brunch.jpg',
    availableDays: [6],
    specialOn: [6],
    badge: 'Sat only',
  },
  {
    id: 'beef-stew',
    category: 'lunch',
    name: 'Beef stew & pap',
    description: 'Slow pot, served with pap.',
    priceCents: randsToCents(72),
    image: 'assets/food/beef-stew.jpg',
    specialOn: [1, 4],
    popular: true,
  },
  {
    id: 'chicken-stew',
    category: 'lunch',
    name: 'Chicken stew',
    description: 'Daily pot — pap or rice on the side.',
    priceCents: randsToCents(70),
    image: 'assets/food/chicken-stew.jpg',
  },
  {
    id: 'mogodu',
    category: 'lunch',
    name: 'Mogodu & pap',
    description: 'Tripe, dumpling or pap, chilli oil.',
    priceCents: randsToCents(80),
    image: 'assets/food/spicy.jpg',
    specialOn: [2],
  },
  {
    id: 'veg-curry',
    category: 'lunch',
    name: 'Veg curry & rice',
    description: 'Vegetarian pot of the day with rice.',
    priceCents: randsToCents(60),
    image: 'assets/food/veg-curry.jpg',
  },
  {
    id: 'chicken-2pc',
    category: 'grill',
    name: 'Fried chicken 2pc',
    description: 'Crisp pieces. Add chips or pap.',
    priceCents: randsToCents(55),
    image: 'assets/food/chicken-2pc.jpg',
  },
  {
    id: 'chicken-3pc',
    category: 'grill',
    name: 'Fried chicken 3pc',
    description: 'Wednesday favourite — pap or chips.',
    priceCents: randsToCents(68),
    image: 'assets/food/chicken.jpg',
    specialOn: [3],
    popular: true,
  },
  {
    id: 'campus-burger',
    category: 'grill',
    name: 'Campus burger & chips',
    description: 'Sesame bun, cheese, chips in the box.',
    priceCents: randsToCents(69),
    image: 'assets/food/burger.jpg',
    popular: true,
  },
  {
    id: 'pap-wors',
    category: 'grill',
    name: 'Pap & wors',
    description: 'Grill plate. Friday shisa nyama energy.',
    priceCents: randsToCents(65),
    image: 'assets/food/grill.jpg',
    specialOn: [5],
  },
  {
    id: 'pap-gravy',
    category: 'sides',
    name: 'Pap & gravy',
    description: 'Soft pap with gravy from the pot.',
    priceCents: randsToCents(35),
    image: 'assets/food/spicy.jpg',
  },
  {
    id: 'chakalaka',
    category: 'sides',
    name: 'Chakalaka beans',
    description: 'Slow pot. Dumpling or pap on request.',
    priceCents: randsToCents(28),
    image: 'assets/food/veg-curry.jpg',
  },
  {
    id: 'chips',
    category: 'sides',
    name: 'Chips',
    description: 'Hot portion, salted.',
    priceCents: randsToCents(30),
    image: 'assets/food/chips.jpg',
  },
  {
    id: 'salad-box',
    category: 'sides',
    name: 'Salad box',
    description: 'Fresh box when you want something light.',
    priceCents: randsToCents(42),
    image: 'assets/food/salad.jpg',
  },
  {
    id: 'coffee-tea',
    category: 'drinks',
    name: 'Coffee / tea',
    description: 'Hot cup from the counter.',
    priceCents: randsToCents(22),
    image: 'assets/food/coffee.jpg',
  },
  {
    id: 'juice',
    category: 'drinks',
    name: 'Juice',
    description: 'Cold juice, fridge stock.',
    priceCents: randsToCents(20),
    image: 'assets/food/juice.jpg',
  },
  {
    id: 'milkshake',
    category: 'drinks',
    name: 'Milkshake',
    description: 'Thick shake when the blender is on.',
    priceCents: randsToCents(32),
    image: 'assets/food/milkshake.jpg',
  },
];

const byId = new Map(menuItems.map((item) => [item.id, item]));

export function getMenuItem(id) {
  return byId.get(id) ?? null;
}

export function getMenu() {
  return menuItems;
}
