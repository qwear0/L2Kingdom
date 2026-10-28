const EnchantRules = invoke('GameServer/Items/C4EnchantRules');
const FORMAL_WEAR_CONFLICT_SLOTS = Object.freeze([6, 7, 8, 9, 10, 11, 12, 14, 15]);

function armorStat(item, method, fallback) {
    if (!item) return fallback;
    return (Number(item[method]?.() || 0) || 0) + EnchantRules.statBonus(item, method === 'fetchPDef' ? 'pDef' : 'mDef');
}

class BackpackModel {
    constructor(data) {
        this.items = [];
        this.paperdoll = BackpackModel.projectEquipment([], data).paperdoll;
    }

    static formalWearConflictSlots = FORMAL_WEAR_CONFLICT_SLOTS;

    // Physical rows are authoritative when supplied; old appearance-only snapshots
    // still need padding. This projection is pure: only Shared may persist repairs,
    // never virtual shops/duel copies. Numeric IDs break malformed-save ties, not time.
    static projectEquipment(rows, appearance = []) {
        const paperdoll = Array.from({ length: 18 }, (_, slot) => ({ ...appearance?.[slot] }));
        const repaired = new Set();
        if (!rows.length) return { paperdoll, repaired };

        const equipped = new Map();
        const remove = (row) => {
            repaired.add(row);
            equipped.delete(row.slot);
        };
        for (const row of rows) {
            if (!row.equipped) continue;
            const current = equipped.get(row.slot);
            if (!current || Number(row.id) > Number(current.id)) {
                if (current) remove(current);
                equipped.set(row.slot, row);
            } else repaired.add(row);
        }
        if (!equipped.size) return { paperdoll, repaired };
        for (let slot = 0; slot < paperdoll.length; slot++) paperdoll[slot] = {};
        if (equipped.has(14) && equipped.has(8)) remove(equipped.get(8));

        const dress = equipped.get(17);
        if (dress) {
            const conflicts = FORMAL_WEAR_CONFLICT_SLOTS.map(slot => equipped.get(slot)).filter(Boolean);
            if (conflicts.some(row => Number(row.id) >= Number(dress.id))) remove(dress);
            else conflicts.forEach(remove);
        }
        for (const row of equipped.values()) {
            const entry = { id: row.id, selfId: row.selfId };
            paperdoll[row.slot] = entry;
            if (row.slot === 15) paperdoll[10] = entry;
        }
        if (equipped.has(17)) paperdoll[10] = paperdoll[17];
        return { paperdoll, repaired };
    }

    // Enum
    equipment = {
     underwear:  0,
          earr:  1,
          earl:  2,
          neck:  3,
            fr:  4,
            fl:  5,
          head:  6,
        weapon:  7,
        shield:  8,
         hands:  9,
         chest: 10,
         pants: 11,
          feet: 12,
         cloak: 13,
          dual: 14,
         armor: 15,
          hair: 16,
    formalWear: 17,
    }

    // Set

    equipmentChanged() {
        this.equipmentRevision = Number(this.equipmentRevision || 0) + 1;
    }

    equipPaperdoll(slot, id, selfId) {
        const equip = this.equipment;

        if (slot === equip.armor || slot === equip.formalWear) {
            this.paperdoll[equip.chest] = { id, selfId };
        }

        this.paperdoll[slot] = { id: id, selfId: selfId };
        this.equipmentChanged();
        this.visibleLook = null; // Social/VisibleStrength
    }

    unequipPaperdoll(slot) {
        const equip = this.equipment;

        if ((slot === equip.armor || slot === equip.formalWear)
            && this.paperdoll[equip.chest].id === this.paperdoll[slot].id) {
            this.paperdoll[equip.chest] = {};
        }

        this.paperdoll[slot] = {};
        this.equipmentChanged();
        this.visibleLook = null; // Social/VisibleStrength
    }

    // Get

    fetchItems() {
        return this.items;
    }

    fetchItem(id, success) {
        const item = this.fetchItems().find((ob) => ob.fetchId() === id);
        item ? success(item) : null;
    }

    fetchItemRaw(id) {
        return this.fetchItems().find((ob) => ob.fetchId() === id);
    }

    fetchItemFromSelfId(selfId) {
        return this.fetchItems().find((ob) => ob.fetchSelfId() === selfId);
    }

    fetchPaperdollId(slot) {
        return this.paperdoll[slot].id;
    }

    fetchPaperdollSelfId(slot) {
        return this.paperdoll[slot].selfId;
    }

    isWearingFormalWear() {
        return Boolean(this.paperdoll[this.equipment.formalWear].id);
    }

    // Abstract

    fetchEquippedArmor(slot) {
        const physicalSlot = slot === this.equipment.chest && this.isWearingFormalWear()
            ? this.equipment.formalWear : slot;
        return this.fetchItems().find(ob => ob.isArmor () && ob.fetchEquipped() && ob.fetchSlot() === physicalSlot);
    }

    fetchEquippedArmors() {
        return this.fetchItems().filter(ob => ob.isArmor() && ob.fetchEquipped());
    }

    fetchEquippedWeapon() {
        return this.fetchItems().find(ob => ob.isWeapon() && ob.fetchEquipped());
    }

    fetchTotalArmorPDef(spellcaster) {
        const equip = this.equipment;
        const fullBody = this.fetchEquippedArmor(equip.armor);
        const torsoPDef = fullBody
            ? armorStat(fullBody, 'fetchPDef', 0)
            : (
                armorStat(this.fetchEquippedArmor(equip.chest), 'fetchPDef', spellcaster ? 15 : 31) +
                armorStat(this.fetchEquippedArmor(equip.pants), 'fetchPDef', spellcaster ? 8 : 18)
            );

        return (
            armorStat(this.fetchEquippedArmor(equip.underwear), 'fetchPDef', 0) +
            armorStat(this.fetchEquippedArmor(equip.head), 'fetchPDef', 12) +
            torsoPDef +
            armorStat(this.fetchEquippedArmor(equip.hands), 'fetchPDef', 8) +
            armorStat(this.fetchEquippedArmor(equip.feet), 'fetchPDef', 7) +
            armorStat(this.fetchEquippedArmor(equip.cloak), 'fetchPDef', 0)
        );
    }

    fetchTotalShieldPDef() {
        return armorStat(this.fetchEquippedArmor(this.equipment.shield), 'fetchPDef', 0);
    }

    fetchTotalShieldRate() {
        const shield = this.fetchEquippedArmor(this.equipment.shield);
        if (!shield) return 0;
        return shield.fetchShieldRate?.() || 20;
    }

    fetchTotalArmorMDef() {
        const equip = this.equipment;

        return (
            armorStat(this.fetchEquippedArmor(equip.neck), 'fetchMDef', 13) +
            armorStat(this.fetchEquippedArmor(equip.earr), 'fetchMDef', 9) +
            armorStat(this.fetchEquippedArmor(equip.earl), 'fetchMDef', 9) +
            armorStat(this.fetchEquippedArmor(equip.fr), 'fetchMDef', 5) +
            armorStat(this.fetchEquippedArmor(equip.fl), 'fetchMDef', 5)
        );
    }

    fetchTotalArmorEvasion() {
        let values = this.fetchEquippedArmors().map((ob) => ob.fetchEvasion() ?? 0) ?? [];
        return values.reduce((acc, value) => acc + value, 0);
    }

    fetchTotalArmorBonusMp() {
        let values = this.fetchEquippedArmors().map((ob) => ob.fetchBonusMp() ?? 0) ?? [];
        return values.reduce((acc, value) => acc + value, 0);
    }

    fetchTotalWeaponPAtk() {
        const weapon = this.fetchEquippedWeapon();
        return weapon ? weapon.fetchPAtk() + EnchantRules.statBonus(weapon, 'pAtk') : undefined;
    }

    fetchTotalWeaponPAtkRnd() {
        return this.fetchEquippedWeapon()?.fetchPAtkRnd();
    }

    fetchTotalWeaponMAtk() {
        const weapon = this.fetchEquippedWeapon();
        return weapon ? weapon.fetchMAtk() + EnchantRules.statBonus(weapon, 'mAtk') : undefined;
    }

    fetchTotalWeaponAtkSpd() {
        return this.fetchEquippedWeapon()?.fetchAtkSpd();
    }

    fetchTotalWeaponCritical() {
        return this.fetchEquippedWeapon()?.fetchCritical();
    }

    fetchTotalWeaponAccur() {
        return this.fetchEquippedWeapon()?.fetchAccur();
    }

    fetchTotalWeaponKind() {
        return this.fetchEquippedWeapon()?.fetchKind();
    }

    fetchTotalWeaponSoulshot() {
        return this.fetchEquippedWeapon()?.fetchSoulshot() ?? 1;
    }

    fetchTotalWeaponSpiritshot() {
        return this.fetchEquippedWeapon()?.fetchSpiritshot() ?? 1;
    }

    fetchTotalLoad() {
        return this.fetchItems().reduce((load, item) =>
            load + item.fetchMass() * item.fetchAmount(), 0);
    }

    fetchTotalAdena() {
        return this.fetchItemFromSelfId(57)?.fetchAmount() ?? 0;
    }

    stackableExists(selfId) {
        return new Promise((success, fail) => {
            let item = this.fetchItems().find((ob) => ob.fetchSelfId() === selfId && ob.fetchStackable());
            return item ? success(item) : fail();
        });
    }
}

module.exports = BackpackModel;
