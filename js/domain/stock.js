function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

export function recipeFor(recipes, itemId) {
  return (recipes || []).filter((row) => row.menuItemId === itemId);
}

export function recipeCostCents(recipes, ingredients, itemId) {
  const byId = new Map((ingredients || []).map((row) => [row.id, row]));
  let total = 0;
  for (const recipe of recipeFor(recipes, itemId)) {
    const ingredient = byId.get(recipe.ingredientId);
    if (!ingredient) continue;
    total += Math.round(Number(ingredient.costCents) * Number(recipe.qty));
  }
  return total;
}

export function deductIngredients(ingredients, recipes, lines, { reason = 'sale', ref = '' } = {}) {
  const next = (ingredients || []).map((row) => ({ ...row }));
  const byId = new Map(next.map((row) => [row.id, row]));
  const movements = [];
  for (const line of lines || []) {
    for (const recipe of recipeFor(recipes, line.itemId)) {
      const ingredient = byId.get(recipe.ingredientId);
      if (!ingredient) continue;
      const qty = round3(Number(recipe.qty) * Number(line.qty));
      ingredient.onHand = round3(Number(ingredient.onHand) - qty);
      movements.push({
        ingredientId: ingredient.id,
        qtyDelta: -qty,
        reason,
        ref,
        itemId: line.itemId,
      });
    }
  }
  return { ingredients: next, movements };
}

export function applyPortions(portions, soldOut, lines, lowThreshold) {
  const nextPortions = { ...(portions || {}) };
  const nextSold = { ...(soldOut || {}) };
  const alerts = [];
  for (const line of lines || []) {
    if (nextPortions[line.itemId] == null) continue;
    const left = Number(nextPortions[line.itemId]) - Number(line.qty);
    nextPortions[line.itemId] = Math.max(0, left);
    if (left <= 0) {
      nextSold[line.itemId] = true;
      alerts.push({ itemId: line.itemId, kind: 'sold-out', portions: 0 });
    } else if (left <= lowThreshold) {
      alerts.push({ itemId: line.itemId, kind: 'low', portions: left });
    }
  }
  return { portions: nextPortions, soldOut: nextSold, alerts };
}

export function restoreSale(ingredients, recipes, portions, lines) {
  const deducted = deductIngredients(ingredients, recipes, (lines || []).map((line) => ({ ...line, qty: -Number(line.qty) })), {
    reason: 'refund',
  });
  const nextPortions = { ...(portions || {}) };
  for (const line of lines || []) {
    if (nextPortions[line.itemId] == null) continue;
    nextPortions[line.itemId] = round3(Number(nextPortions[line.itemId]) + Number(line.qty));
  }
  return { ingredients: deducted.ingredients, movements: deducted.movements, portions: nextPortions };
}

export function receiveIngredient(ingredients, { ingredientId, qty, note = '' }) {
  const amount = Number(qty);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a quantity received.');
  const next = ingredients.map((row) => ({ ...row }));
  const ingredient = next.find((row) => row.id === ingredientId);
  if (!ingredient) throw new Error('Unknown stock item.');
  ingredient.onHand = round3(Number(ingredient.onHand) + amount);
  return {
    ingredients: next,
    ingredient,
    movement: { ingredientId, qtyDelta: amount, reason: 'receive', note },
    receipt: { ingredientId, qty: amount, costCents: Math.round(ingredient.costCents * amount), note },
  };
}

export function wasteIngredient(ingredients, { ingredientId, qty, reason = '' }) {
  const amount = Number(qty);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a waste quantity.');
  const next = ingredients.map((row) => ({ ...row }));
  const ingredient = next.find((row) => row.id === ingredientId);
  if (!ingredient) throw new Error('Unknown stock item.');
  ingredient.onHand = round3(Number(ingredient.onHand) - amount);
  return {
    ingredients: next,
    ingredient,
    movement: { ingredientId, qtyDelta: -amount, reason: 'waste', note: reason },
    waste: {
      ingredientId,
      name: ingredient.name,
      qty: amount,
      unit: ingredient.unit,
      costCents: Math.round(ingredient.costCents * amount),
      reason,
    },
  };
}

export function applyStockTake(ingredients, lines) {
  const next = ingredients.map((row) => ({ ...row }));
  const byId = new Map(next.map((row) => [row.id, row]));
  const variances = [];
  const movements = [];
  for (const line of lines || []) {
    const ingredient = byId.get(line.ingredientId);
    if (!ingredient) continue;
    const counted = Number(line.countedQty);
    if (!Number.isFinite(counted) || counted < 0) throw new Error(`Count for ${ingredient.name} is not valid.`);
    const expected = Number(ingredient.onHand);
    const variance = round3(counted - expected);
    ingredient.onHand = round3(counted);
    variances.push({
      ingredientId: ingredient.id,
      name: ingredient.name,
      unit: ingredient.unit,
      expectedQty: expected,
      countedQty: counted,
      variance,
    });
    if (variance !== 0) {
      movements.push({ ingredientId: ingredient.id, qtyDelta: variance, reason: 'stock-take' });
    }
  }
  return { ingredients: next, variances, movements };
}

export function reorderSuggestions(ingredients) {
  return (ingredients || [])
    .filter((row) => Number(row.onHand) <= Number(row.reorderLevel))
    .map((row) => {
      const suggest = Math.max(Number(row.reorderLevel), round3(Number(row.reorderLevel) * 2 - Number(row.onHand)));
      return {
        ingredientId: row.id,
        name: row.name,
        unit: row.unit,
        onHand: row.onHand,
        reorderLevel: row.reorderLevel,
        suggestQty: suggest,
        supplierId: row.supplierId,
        costCents: Math.round(Number(row.costCents) * suggest),
      };
    })
    .sort((a, b) => a.onHand - b.onHand);
}

export function stockValueCents(ingredients) {
  return (ingredients || []).reduce((sum, row) => sum + Math.round(Math.max(0, Number(row.onHand)) * Number(row.costCents)), 0);
}

export function isHidden(soldOut, portions, itemId) {
  if (soldOut?.[itemId]) return true;
  if (portions?.[itemId] != null && Number(portions[itemId]) <= 0) return true;
  return false;
}
