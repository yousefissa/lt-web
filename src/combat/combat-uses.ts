import type { ItemObject } from '../objects/item';
import type { UnitObject } from '../objects/unit';
import type { CombatStrike } from './combat-solver';

interface UsesOptions {
  lose_uses_on_miss?: boolean;
  one_loss_per_combat?: boolean;
}

/** Apply LT's hit/miss and one-loss-per-combat durability semantics. */
export function consumeCombatItemUses(
  unit: UnitObject,
  item: ItemObject,
  strikes: CombatStrike[],
): boolean {
  if (item.maxUses <= 0) return false;
  const options = item.getComponent<UsesOptions>('uses_options') ?? {};
  const eligible = strikes.filter(
    (strike) => strike.attacker === unit
      && strike.item === item
      && (strike.hit || options.lose_uses_on_miss === true),
  ).length;
  const usesToConsume = options.one_loss_per_combat && eligible > 0 ? 1 : eligible;
  let broken = false;
  for (let index = 0; index < usesToConsume && item.hasUsesRemaining(); index++) {
    broken = item.decrementUses() || broken;
  }
  if (broken) {
    const inventoryIndex = unit.items.indexOf(item);
    if (inventoryIndex >= 0) unit.items.splice(inventoryIndex, 1);
    unit.unequipWeapon(item);
  }
  return broken;
}
