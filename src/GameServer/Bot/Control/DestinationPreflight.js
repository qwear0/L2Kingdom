'use strict';

const { diagnosticLimits: limits, actionLimits, fault } = require('../../../Mcp/Contracts');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Surface = invoke('GameServer/Geodata/SpawnSurface');
const directions = [
    { name: 'north', dx: 0, dy: -16, bit: 8, opposite: 4 },
    { name: 'south', dx: 0, dy: 16, bit: 4, opposite: 8 },
    { name: 'east', dx: 16, dy: 0, bit: 1, opposite: 2 },
    { name: 'west', dx: -16, dy: 0, bit: 2, opposite: 1 }
];
function nearest(layers, z) {
    let selected = null;
    for (const layer of layers) if (!selected || Math.abs(layer.z - z) < Math.abs(selected.z - z)) selected = layer;
    return selected;
}
function inspect(from, to, checkDirect) {
    const distanceXY = Math.hypot(to.locX - from.locX, to.locY - from.locY);
    if (distanceXY > limits.destinationDistanceXY) throw fault('diagnostic_distance_budget', 409,
        { distanceXY, maxDistanceXY: limits.destinationDistanceXY });
    let cells = 0, transitions = 0;
    const budget = {
        beforeLayers() { if (++cells > limits.layerCells) throw fault('diagnostic_work_budget', 429); },
        decoded() {}, walk() {},
        transition() { if (++transitions > limits.transitions) throw fault('diagnostic_work_budget', 429); }
    };
    const layers = Surface.layers(to.locX, to.locY, budget);
    const selected = nearest(layers, to.locZ);
    const virtualObstacle = Geo.checkVirtualObstacles(to.locX, to.locY, Geo.getRegionKey(to.locX, to.locY));
    const hasGeodata = Geo.hasGeo(to.locX, to.locY);
    const zDelta = selected ? selected.z - to.locZ : null;
    const supported = !!selected && selected.nswe !== 0 && Math.abs(zDelta) <= actionLimits.arrivalZ;
    const result = { sampledAt: Date.now(), source: 'current_server_geodata_not_client_collision', requestedTo: to,
        distanceXY, hasGeodata, virtualObstacle, selectedLayer: selected, requestedZDelta: zDelta,
        supportedAtRequestedZ: supported, layers: layers.slice(0, limits.displayedLayers),
        layerCount: layers.length, layersTruncated: layers.length > limits.displayedLayers,
        reason: virtualObstacle ? 'virtual_obstacle' : !hasGeodata ? 'missing_geodata' : !selected ? 'no_decodable_layer'
            : Math.abs(zDelta) > actionLimits.arrivalZ ? 'requested_z_mismatch' : !selected.nswe ? 'closed_cell' : 'supported',
        connections: [], routeReachable: null,
        direct: { status: 'not_checked', reason: checkDirect ? 'destination_unsupported' : 'not_requested' } };
    // Connections concern the selected real layer, even when requested Z is bad.
    // Local exits and a failed direct walk do not establish global reachability.
    if (selected) for (const direction of directions) {
        const locX = ((to.locX >> 4) << 4) + 8 + direction.dx;
        const locY = ((to.locY >> 4) << 4) + 8 + direction.dy;
        const neighbor = nearest(Surface.layers(locX, locY, budget), selected.z);
        const reason = !(selected.nswe & direction.bit) ? 'source_nswe_blocked'
            : !neighbor ? 'no_supported_neighbor_layer'
                : Math.abs(neighbor.z - selected.z) > actionLimits.arrivalZ ? 'layer_step'
                    : !(neighbor.nswe & direction.opposite) ? 'neighbor_nswe_blocked' : 'connected';
        result.connections.push({ direction: direction.name, locX, locY, layer: neighbor, allowed: reason === 'connected', reason });
    }
    if (checkDirect && distanceXY > limits.directDistanceXY) {
        result.direct = { status: 'not_checked', reason: 'direct_distance_budget', maxDistanceXY: limits.directDistanceXY };
    } else if (checkDirect && supported) {
        try {
            const target = { ...to, locZ: selected.z };
            // Strict surface connectivity can take either cardinal corner route;
            // authoritative straight movement additionally requires walkSegment.
            const surface = Surface.walk(from, target, budget);
            const landing = surface && Geo.walkSegment(from, target) ? surface : null;
            result.routeReachable = landing ? true : null;
            result.direct = { status: 'checked', connected: !!landing, landing,
                reason: landing ? 'connected_to_selected_layer' : 'direct_segment_not_proven' };
        } catch (error) {
            if (error.code !== 'diagnostic_work_budget') throw error;
            result.direct = { status: 'incomplete', reason: error.code, connected: null };
        }
    }
    result.work = { strictLayerCells: cells, strictTransitions: transitions };
    result.navigation = Geo.inputIdentity();
    return result;
}
module.exports = { inspect };
