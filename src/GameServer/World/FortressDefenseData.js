const MANAGER_ID = 7495;
const START = Object.freeze({ locX: 43280, locY: 108840, locZ: -1984 });
const SQUAD_POSITIONS = [
    { locX: 43420, locY: 108840, locZ: -1984 },
    { locX: 43420, locY: 108600, locZ: -1984 },
    { locX: 43540, locY: 108600, locZ: -1984 },
    { locX: 43420, locY: 108720, locZ: -1984 },
    { locX: 43540, locY: 108720, locZ: -1984 }
];

// The western hillside rises sharply immediately behind Tamutak. Approach
// through the lower eastern/northern/southern court instead. Native geodata
// paths and each next movement segment are checked, including the entrance
// around Harkel (43996,108998); a blocked route must never become a teleport.
const ROUTES = [
    [{ locX: 45600, locY: 108840, locZ: -2032 }, { locX: 44640, locY: 108840, locZ: -2032 }],
    [{ locX: 44400, locY: 108160, locZ: -2032 }, { locX: 44400, locY: 108440, locZ: -2032 }],
    [{ locX: 44800, locY: 109640, locZ: -2032 }, { locX: 44400, locY: 109280, locZ: -2032 }]
];

// 21_21.l2j: the two omitted cells are raised/isolated terrain, not court
// floor. Every retained holding slot has a native path to the manager area.
const HOLDING_POSITIONS = Array.from({ length: 80 }, (_, index) => ({
    locX: 43320 + (index % 10) * 120,
    locY: 108440 + Math.floor(index / 10) * 120,
    locZ: -2032
})).filter((_, index) => index !== 1 && index !== 74).slice(0, 75);

function attacker(group, member) {
    const route = group % ROUTES.length;
    const row = Math.floor(group / ROUTES.length);
    const anchors = ROUTES[route];
    const offset = (member - 2) * 120;
    const spawn = route === 0 ? { ...anchors[0], locY: anchors[0].locY + offset }
        : { ...anchors[0], locX: anchors[0].locX + offset };
    const approach = route === 0 ? { ...anchors[1], locY: anchors[1].locY + offset }
        : { ...anchors[1], locX: anchors[1].locX + offset };
    const finish = HOLDING_POSITIONS[route * 25 + row * 5 + member];
    const selfId = group < 5 ? 547 : group < 10 ? (member === 4 ? 63 : 547)
        : [547, 547, 63, 207, 207][member];
    return { group, member, route, selfId, spawn, points: [approach, finish] };
}

module.exports = { MANAGER_ID, START, SQUAD_POSITIONS, ROUTES, HOLDING_POSITIONS, attacker, GROUPS: 15, GROUP_SIZE: 5, INTERVAL_MS: 30000 };
