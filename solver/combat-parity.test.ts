import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeCombatItemUses } from '../src/combat/combat-uses';
import type { CombatStrike } from '../src/combat/combat-solver';
import type { ItemObject } from '../src/objects/item';
import type { UnitObject } from '../src/objects/unit';

test('combat durability follows LT hit, miss, and one-loss-per-combat semantics', () => {
  const item = fakeItem();
  const unit = { items: [item] } as unknown as UnitObject;
  const target = {} as UnitObject;
  const strikes = [true, false, true].map((hit) => ({
    attacker: unit,
    defender: target,
    item,
    hit,
    crit: false,
    damage: hit ? 3 : 0,
    isCounter: false,
  })) as CombatStrike[];

  consumeCombatItemUses(unit, item, strikes);
  assert.equal(item.uses, 8, 'default durability is spent once per successful strike');

  item.uses = 10;
  item.components.set('uses_options', { lose_uses_on_miss: true, one_loss_per_combat: false });
  consumeCombatItemUses(unit, item, strikes);
  assert.equal(item.uses, 7, 'configured misses also spend durability');

  item.uses = 10;
  item.components.set('uses_options', { lose_uses_on_miss: true, one_loss_per_combat: true });
  consumeCombatItemUses(unit, item, strikes);
  assert.equal(item.uses, 9, 'one-loss-per-combat consumes exactly one use');
});

function fakeItem(): ItemObject {
  interface MutableFakeItem {
    maxUses: number;
    uses: number;
    components: Map<string, unknown>;
    getComponent<T>(nid: string): T | undefined;
    hasUsesRemaining(): boolean;
    decrementUses(): boolean;
  }
  const item: MutableFakeItem = {
    maxUses: 10,
    uses: 10,
    components: new Map([['uses_options', {
      lose_uses_on_miss: false,
      one_loss_per_combat: false,
    }]]),
    getComponent<T>(nid: string): T | undefined {
      return this.components.get(nid) as T | undefined;
    },
    hasUsesRemaining(): boolean {
      return this.uses > 0;
    },
    decrementUses(): boolean {
      this.uses--;
      return this.uses <= 0;
    },
  };
  return item as unknown as ItemObject;
}
