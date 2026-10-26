const fs = require('fs');
const path = require('path');
const VirtualObstacles = invoke('GameServer/Geodata/VirtualObstacles/index');

const REGION_OFFSET_X = 20;
const REGION_OFFSET_Y = 18;
const MAX_LAYER_STEP = 64;

class BinaryMinHeap {
    constructor(compare) {
        this.items = [];
        this.compare = compare;
    }

    get length() {
        return this.items.length;
    }

    push(value) {
        const items = this.items;
        let index = items.length;
        items.push(value);
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (this.compare(items[parent], value) <= 0) break;
            items[index] = items[parent];
            index = parent;
        }
        items[index] = value;
    }

    shift() {
        const items = this.items;
        if (!items.length) return null;
        const first = items[0];
        const last = items.pop();
        if (!items.length) return first;

        let index = 0;
        while (index * 2 + 1 < items.length) {
            const left = index * 2 + 1;
            const right = left + 1;
            const child = right < items.length && this.compare(items[right], items[left]) < 0 ? right : left;
            if (this.compare(items[child], last) >= 0) break;
            items[index] = items[child];
            index = child;
        }
        items[index] = last;
        return first;
    }
}

function getRegionX(x) {
    return (x >> 15) + REGION_OFFSET_X;
}

function getRegionY(y) {
    return (y >> 15) + REGION_OFFSET_Y;
}

function getLocalX(x, regionX) {
    return x - ((regionX - REGION_OFFSET_X) << 15);
}

function getLocalY(y, regionY) {
    return y - ((regionY - REGION_OFFSET_Y) << 15);
}

const GeodataEngine = {
    regions: {}, // Loaded region buffers, keyed by "XX_YY"
    missing: {}, // Keys of missing regions, to prevent console spam and repeat disk checks

    init() {
        this.navigationRevision = Number(this.navigationRevision || 0) + 1;
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info("GeodataEngine :: Initializing...");
        VirtualObstacles.init();
        // Preload active regions on startup
        // L2J geodata file names follow client map regions, e.g. T_22_19.
        const activeRegions = [
            // Talking Island (x≈-84k, y≈244k)
            { x: 17, y: 25 }, // Talking Island Village (core)
            { x: 17, y: 24 }, // Talking Island (south)

            // Gludin (x≈-80k, y≈149k)
            { x: 17, y: 22 }, // Gludin Town (core)
            { x: 17, y: 21 }, // Gludin (south)
            { x: 17, y: 23 }, // Gludin (north)

            // Gludio (x≈-12k, y≈122k)
            { x: 19, y: 21 }, // Gludio Town (core)
            { x: 19, y: 20 }, // Gludio (south)
            { x: 19, y: 22 }, // Gludio (north)

            // Dion (x≈15k, y≈142k)
            { x: 20, y: 22 }, // Dion Town (core)
            { x: 20, y: 21 }, // Dion (south)

            // Dark Elven Village (x≈9k, y≈15k)
            { x: 20, y: 18 }, // Dark Elven Village (core)
            { x: 19, y: 18 }, // Dark Elven (west)
            { x: 20, y: 19 }, // Dark Elven (north)

            // Orc Village area (x≈84k, y≈-112k)
            { x: 22, y: 14 }, // Orc Village area
            { x: 21, y: 14 }, // Orc Village adjacent area

            // Neutral Zone / Elven Forest (x≈-10k, y≈75k)
            { x: 19, y: 20 }, // Neutral Zone area (already loaded for Gludio south)

            // General world areas for pathfinding
            { x: 20, y: 20 }, // Central area
            { x: 19, y: 19 }, // Between cities
        ];
        activeRegions.forEach(reg => {
            this.loadRegion(reg.x, reg.y);
        });
    },

    getGeodataDir() {
        return process.env.L2NODE_GEODATA_DIR || path.join(__dirname, '../../../data/Geodata');
    },

    getRegionKey(x, y) {
        return `${getRegionX(x)}_${getRegionY(y)}`;
    },

    loadRegion(regionX, regionY) {
        const key = `${regionX}_${regionY}`;
        if (this.missing[key]) {
            return false;
        }
        
        const filePath = path.join(this.getGeodataDir(), `${key}.l2j`);
        
        if (fs.existsSync(filePath)) {
            try {
                const buffer = fs.readFileSync(filePath);
                this.regions[key] = buffer;
                
                // Build block offset index table
                const offsetIndex = this.buildOffsetIndex(buffer);
                this[`index_${key}`] = offsetIndex;

                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) utils.infoSuccess("GeodataEngine", "Loaded region geodata: %s (Size: %s MB)", key, (buffer.length / (1024 * 1024)).toFixed(2));
                return true;
            } catch (err) {
                console.error(`GeodataEngine :: Failed to load region ${key}:`, err);
            }
        } else {
            this.missing[key] = true;
            utils.infoWarn("GeodataEngine", "Geodata file not found: %s", filePath);
        }
        return false;
    },

    getRegionBuffer(regionX, regionY) {
        const key = `${regionX}_${regionY}`;
        if (this.regions[key]) {
            return this.regions[key];
        }
        // Try to load dynamically
        if (this.loadRegion(regionX, regionY)) {
            return this.regions[key];
        }
        return null;
    },

    hasGeo(x, y) {
        return !!this.regions[this.getRegionKey(x, y)];
    },

    getHeight(x, y, z) {
        const regionX = getRegionX(x);
        const regionY = getRegionY(y);

        const buffer = this.getRegionBuffer(regionX, regionY);
        if (!buffer) {
            return z; // Fallback to current Z height if region geodata is not loaded
        }

        // Calculate local coordinates inside the region (0 to 32767)
        const localX = getLocalX(x, regionX);
        const localY = getLocalY(y, regionY);

        // Calculate block index inside the region (0 to 255)
        const blockX = localX >> 7;
        const blockY = localY >> 7;

        // Calculate cell index inside the block (0 to 7)
        const cellX = (localX >> 4) & 7;
        const cellY = (localY >> 4) & 7;

        const key = `${regionX}_${regionY}`;
        const offsetIndex = this[`index_${key}`];
        if (!offsetIndex) {
            return z;
        }

        const blockId = (blockX * 256) + blockY;
        const blockOffset = offsetIndex[blockId];
        if (blockOffset === undefined) {
            return z;
        }

        // Read block type (1 byte)
        const type = buffer.readUInt8(blockOffset);
        let cellOffset = blockOffset + 1;

        if (type === 0) { // FLAT
            const flatZ = buffer.readInt16LE(cellOffset);
            return flatZ;
        } else if (type === 1) { // COMPLEX
            const cellId = (cellX * 8) + cellY;
            const value = buffer.readInt16LE(cellOffset + (cellId * 2));
            const cellZ = ((value & 0xFFF0) << 16) >> 17;
            return cellZ;
        } else if (type === 2) { // MULTILEVEL
            const targetCellId = (cellX * 8) + cellY;
            let tempOffset = cellOffset;
            for (let i = 0; i < targetCellId; i++) {
                const layers = buffer.readUInt8(tempOffset);
                tempOffset += 1 + (layers * 2);
            }

            const layers = buffer.readUInt8(tempOffset);
            if (layers === 0) {
                return z;
            }

            tempOffset += 1;
            // Scan layers to find the one closest to current Z-height
            let closestZ = z;
            let minDiff = Infinity;

            for (let l = 0; l < layers; l++) {
                const value = buffer.readInt16LE(tempOffset + (l * 2));
                const layerZ = ((value & 0xFFF0) << 16) >> 17;
                const diff = Math.abs(layerZ - z);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestZ = layerZ;
                }
            }
            return closestZ;
        }

        return z;
    },

    checkVirtualObstacles(x, y, regionKey) {
        return VirtualObstacles.checkObstacle(x, y, regionKey);
    },

    getCellData(x, y, z) {
        const regionX = getRegionX(x);
        const regionY = getRegionY(y);
        const regionKey = `${regionX}_${regionY}`;

        if (this.checkVirtualObstacles(x, y, regionKey)) {
            return { z: z, nswe: 0, hasLayerData: false }; // Fully blocked
        }

        const buffer = this.getRegionBuffer(regionX, regionY);
        if (!buffer) {
            return { z: z, nswe: 15, hasLayerData: false };
        }

        const localX = getLocalX(x, regionX);
        const localY = getLocalY(y, regionY);

        const blockX = localX >> 7;
        const blockY = localY >> 7;

        const cellX = (localX >> 4) & 7;
        const cellY = (localY >> 4) & 7;

        const key = `${regionX}_${regionY}`;
        const offsetIndex = this[`index_${key}`];
        if (!offsetIndex) {
            return { z: z, nswe: 15, hasLayerData: false };
        }

        const blockId = (blockX * 256) + blockY;
        const blockOffset = offsetIndex[blockId];
        if (blockOffset === undefined) {
            return { z: z, nswe: 15, hasLayerData: false };
        }

        const type = buffer.readUInt8(blockOffset);
        let cellOffset = blockOffset + 1;

        if (type === 0) {
            const flatZ = buffer.readInt16LE(cellOffset);
            return { z: flatZ, nswe: 15, hasLayerData: true };
        } else if (type === 1) {
            const cellId = (cellX * 8) + cellY;
            const value = buffer.readInt16LE(cellOffset + (cellId * 2));
            const cellZ = ((value & 0xFFF0) << 16) >> 17;
            const nswe = value & 0x000F;
            return { z: cellZ, nswe: nswe, hasLayerData: true };
        } else if (type === 2) {
            const targetCellId = (cellX * 8) + cellY;
            let tempOffset = cellOffset;
            for (let i = 0; i < targetCellId; i++) {
                const layers = buffer.readUInt8(tempOffset);
                tempOffset += 1 + (layers * 2);
            }

            const layers = buffer.readUInt8(tempOffset);
            if (layers === 0) {
                return { z: z, nswe: 15, hasLayerData: false };
            }

            tempOffset += 1;
            let closestZ = z;
            let closestNswe = 15;
            let minDiff = Infinity;

            for (let l = 0; l < layers; l++) {
                const value = buffer.readInt16LE(tempOffset + (l * 2));
                const layerZ = ((value & 0xFFF0) << 16) >> 17;
                const diff = Math.abs(layerZ - z);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestZ = layerZ;
                    closestNswe = value & 0x000F;
                }
            }
            return { z: closestZ, nswe: closestNswe, hasLayerData: true };
        }

        return { z: z, nswe: 15, hasLayerData: false };
    },

    hasLineOfSight(fromX, fromY, fromZ, toX, toY, toZ) {
        let cx = fromX >> 4;
        let cy = fromY >> 4;

        const targetCx = toX >> 4;
        const targetCy = toY >> 4;
        const startCell = this.getCellData((cx << 4) + 8, (cy << 4) + 8, fromZ);
        const targetCell = this.getCellData((targetCx << 4) + 8, (targetCy << 4) + 8, toZ);
        const hasLayerData = this.hasGeo(fromX, fromY) && this.hasGeo(toX, toY);
        let cz = startCell.z;

        if (cx === targetCx && cy === targetCy) {
            // A multilevel block can contain several floors in the same XY
            // cell.  Treating that as unconditional visibility is exactly
            // what lets Cruma mobs see through a ceiling.
            return !hasLayerData || startCell.z === targetCell.z;
        }

        const dx = targetCx - cx;
        const dy = targetCy - cy;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));

        const xInc = dx / steps;
        const yInc = dy / steps;

        let floatCx = cx;
        let floatCy = cy;

        for (let i = 0; i < steps; i++) {
            const nextCx = Math.round(floatCx + xInc);
            const nextCy = Math.round(floatCy + yInc);

            const diffX = nextCx - cx;
            const diffY = nextCy - cy;

            if (diffX !== 0 && diffY !== 0) {
                const cellCurr = this.getCellData((cx << 4) + 8, (cy << 4) + 8, cz);
                const cellHoriz = this.getCellData((nextCx << 4) + 8, (cy << 4) + 8, cz);
                const cellDiag = this.getCellData((nextCx << 4) + 8, (nextCy << 4) + 8, cellHoriz.z);

                let path1Passable = Math.abs(cellHoriz.z - cellCurr.z) <= MAX_LAYER_STEP
                    && Math.abs(cellDiag.z - cellHoriz.z) <= MAX_LAYER_STEP;
                if (diffX > 0) {
                    path1Passable = path1Passable && ((cellCurr.nswe & 1) !== 0) && ((cellHoriz.nswe & 2) !== 0);
                } else {
                    path1Passable = path1Passable && ((cellCurr.nswe & 2) !== 0) && ((cellHoriz.nswe & 1) !== 0);
                }
                if (diffY > 0) {
                    path1Passable = path1Passable && ((cellHoriz.nswe & 4) !== 0) && ((cellDiag.nswe & 8) !== 0);
                } else {
                    path1Passable = path1Passable && ((cellHoriz.nswe & 8) !== 0) && ((cellDiag.nswe & 4) !== 0);
                }

                const cellVert = this.getCellData((cx << 4) + 8, (nextCy << 4) + 8, cz);
                const cellDiagViaVertical = this.getCellData((nextCx << 4) + 8, (nextCy << 4) + 8, cellVert.z);
                let path2Passable = Math.abs(cellVert.z - cellCurr.z) <= MAX_LAYER_STEP
                    && Math.abs(cellDiagViaVertical.z - cellVert.z) <= MAX_LAYER_STEP;
                if (diffY > 0) {
                    path2Passable = path2Passable && ((cellCurr.nswe & 4) !== 0) && ((cellVert.nswe & 8) !== 0);
                } else {
                    path2Passable = path2Passable && ((cellCurr.nswe & 8) !== 0) && ((cellVert.nswe & 4) !== 0);
                }
                if (diffX > 0) {
                    path2Passable = path2Passable && ((cellVert.nswe & 1) !== 0) && ((cellDiagViaVertical.nswe & 2) !== 0);
                } else {
                    path2Passable = path2Passable && ((cellVert.nswe & 2) !== 0) && ((cellDiagViaVertical.nswe & 1) !== 0);
                }

                if (!path1Passable && !path2Passable) {
                    return false;
                }

                cz = path1Passable ? cellDiag.z : cellDiagViaVertical.z;
            } else {
                const cellCurr = this.getCellData((cx << 4) + 8, (cy << 4) + 8, cz);
                const cellNext = this.getCellData((nextCx << 4) + 8, (nextCy << 4) + 8, cz);

                if (Math.abs(cellNext.z - cellCurr.z) > MAX_LAYER_STEP) {
                    return false;
                }

                let passable = false;
                if (diffX > 0) {
                    passable = ((cellCurr.nswe & 1) !== 0) && ((cellNext.nswe & 2) !== 0);
                } else if (diffX < 0) {
                    passable = ((cellCurr.nswe & 2) !== 0) && ((cellNext.nswe & 1) !== 0);
                } else if (diffY > 0) {
                    passable = ((cellCurr.nswe & 4) !== 0) && ((cellNext.nswe & 8) !== 0);
                } else if (diffY < 0) {
                    passable = ((cellCurr.nswe & 8) !== 0) && ((cellNext.nswe & 4) !== 0);
                }

                if (!passable) {
                    return false;
                }

                cz = cellNext.z;
            }

            cx = nextCx;
            cy = nextCy;
            floatCx += xInc;
            floatCy += yInc;
        }

        // Walking the source layer is intentional: getCellData selects the
        // layer nearest to cz at every step.  The ray is only valid if it
        // finishes on the target's resolved layer instead of a floor above
        // or below it. Missing geodata keeps the historical permissive
        // fallback so uncovered outdoor regions do not become opaque.
        return !hasLayerData || Math.abs(cz - targetCell.z) <= MAX_LAYER_STEP;
    },

    // Follow the source floor through every cell crossed by the actual line;
    // both sides of a corner must be walkable to avoid isolated roof cells.
    // Requested/interpolated Z is only a fallback where cell layers are absent.
    // matchHeight=false skips endpoint admission, not terrain/NSWE validation.
    walkSegment(from, to, matchHeight = true) {
        if (![from.locX, from.locY, from.locZ, to.locX, to.locY].every(Number.isFinite)) return null;
        let cx = from.locX >> 4, cy = from.locY >> 4;
        const endX = to.locX >> 4, endY = to.locY >> 4;
        let cell = this.getCellData(from.locX, from.locY, from.locZ);
        if (!cell.nswe || Math.abs(cell.z - from.locZ) > MAX_LAYER_STEP) return null;
        const hasTargetZ = Number.isFinite(to.locZ);
        const dx = to.locX - from.locX, dy = to.locY - from.locY;
        const sx = Math.sign(dx), sy = Math.sign(dy);
        const deltaX = dx ? 16 / Math.abs(dx) : Infinity;
        const deltaY = dy ? 16 / Math.abs(dy) : Infinity;
        let nextX = dx ? (((cx + (sx > 0 ? 1 : 0)) << 4) - from.locX) / dx : Infinity;
        let nextY = dy ? (((cy + (sy > 0 ? 1 : 0)) << 4) - from.locY) / dy : Infinity;
        const cross = (source, x, y, stepX, stepY, progress) => {
            const bit = stepX ? (stepX > 0 ? 1 : 2) : (stepY > 0 ? 4 : 8);
            const opposite = stepX ? (stepX > 0 ? 2 : 1) : (stepY > 0 ? 8 : 4);
            if (!(source.nswe & bit)) return null;
            const sourceZ = !source.hasLayerData && hasTargetZ
                ? Math.round(from.locZ + (to.locZ - from.locZ) * progress) : source.z;
            const target = this.getCellData((x << 4) + 8, (y << 4) + 8, sourceZ);
            if (!target.hasLayerData && hasTargetZ) {
                target.z = Math.round(from.locZ + (to.locZ - from.locZ) * progress);
            }
            return (target.nswe & opposite) && (!target.hasLayerData
                || Math.abs(target.z - sourceZ) <= MAX_LAYER_STEP) ? target : null;
        };
        while (cx !== endX || cy !== endY) {
            if (cy === endY || cx !== endX && nextX < nextY - 1e-10) {
                cell = cross(cell, cx + sx, cy, sx, 0, nextX);
                cx += sx;
                nextX += deltaX;
            } else if (cx === endX || nextY < nextX - 1e-10) {
                cell = cross(cell, cx, cy + sy, 0, sy, nextY);
                cy += sy;
                nextY += deltaY;
            } else {
                const horizontal = cross(cell, cx + sx, cy, sx, 0, nextX);
                const vertical = cross(cell, cx, cy + sy, 0, sy, nextY);
                const viaX = horizontal && cross(horizontal, cx + sx, cy + sy, 0, sy, nextX);
                const viaY = vertical && cross(vertical, cx + sx, cy + sy, sx, 0, nextY);
                cell = viaX && viaY && viaX.z === viaY.z ? viaX : null;
                cx += sx;
                cy += sy;
                nextX += deltaX;
                nextY += deltaY;
            }
            if (!cell) return null;
        }
        if (cell.hasLayerData && matchHeight && hasTargetZ && Math.abs(cell.z - to.locZ) > MAX_LAYER_STEP) return null;
        return { locX: to.locX, locY: to.locY, locZ: !cell.hasLayerData && hasTargetZ ? to.locZ : cell.z };
    },

    findPath(startX, startY, startZ, endX, endY, endZ, maxNodes = 2000, options = {}) {
        const checkBudget = typeof options.checkBudget === 'function' ? options.checkBudget : null;
        checkBudget?.();
        const startCx = startX >> 4;
        const startCy = startY >> 4;
        const endCx = endX >> 4;
        const endCy = endY >> 4;
        const startCell = this.getCellData((startCx << 4) + 8, (startCy << 4) + 8, startZ);
        const endCell = this.getCellData((endCx << 4) + 8, (endCy << 4) + 8, endZ);
        const hasLayerData = this.hasGeo(startX, startY) && this.hasGeo(endX, endY);
        const goalRadius = Math.max(0, Number(options.goalRadius || 0));
        const goalZTolerance = goalRadius > 0
            ? Math.max(MAX_LAYER_STEP, Number(options.goalZTolerance || MAX_LAYER_STEP))
            : 0;
        const heuristicWeight = Math.max(1, Number(options.heuristicWeight || 1));
        const heuristic = (cx, cy, cz) => {
            const horizontalSteps = Math.abs(endCx - cx) + Math.abs(endCy - cy);
            const horizontalDistance = goalRadius > 0
                ? Math.max(0, horizontalSteps * 16 - goalRadius * Math.SQRT2)
                : horizontalSteps * 16;
            const verticalSteps = hasLayerData
                ? Math.ceil(Math.abs(endCell.z - cz) / MAX_LAYER_STEP)
                : 0;
            return Math.max(horizontalDistance, verticalSteps * 16);
        };
        const reachedGoal = (node) => {
            if (goalRadius <= 0) {
                return node.cx === endCx
                    && node.cy === endCy
                    && (!hasLayerData || node.cz === endCell.z);
            }
            const dx = ((node.cx << 4) + 8) - endX;
            const dy = ((node.cy << 4) + 8) - endY;
            return Math.hypot(dx, dy) <= goalRadius
                && (!hasLayerData || Math.abs(node.cz - endCell.z) <= goalZTolerance);
        };

        const immediate = { cx: startCx, cy: startCy, cz: startCell.z };
        if (reachedGoal(immediate)) {
            if (goalRadius > 0) {
                return [{ locX: startX, locY: startY, locZ: startZ }];
            }
            return [{ locX: endX, locY: endY, locZ: endZ }];
        }

        const startNode = {
            cx: startCx,
            cy: startCy,
            cz: startCell.z,
            g: 0,
            h: heuristic(startCx, startCy, startCell.z),
            f: 0,
            parent: null
        };
        startNode.f = startNode.g + heuristicWeight * startNode.h;

        let insertOrder = 0;
        startNode.order = insertOrder++;
        const openList = new BinaryMinHeap((left, right) => (
            left.f - right.f || left.h - right.h || left.order - right.order
        ));
        openList.push(startNode);
        const bestCosts = new Map();
        bestCosts.set(`${startCx},${startCy},${startCell.z}`, 0);

        let targetNode = null;
        let nodesExpanded = 0;

        while (openList.length > 0) {
            const current = openList.shift();
            const currentKey = `${current.cx},${current.cy},${current.cz}`;
            if (current.g !== bestCosts.get(currentKey)) {
                continue;
            }

            nodesExpanded++;
            if ((nodesExpanded & 127) === 0) checkBudget?.();
            if (nodesExpanded > maxNodes) {
                break;
            }

            if (reachedGoal(current)) {
                targetNode = current;
                break;
            }

            const currentCell = this.getCellData((current.cx << 4) + 8, (current.cy << 4) + 8, current.cz);
            
            const directions = [
                { dx: 0, dy: -1, bit: 8, oppBit: 4 },
                { dx: 0, dy: 1, bit: 4, oppBit: 8 },
                { dx: 1, dy: 0, bit: 1, oppBit: 2 },
                { dx: -1, dy: 0, bit: 2, oppBit: 1 }
            ];

            for (const dir of directions) {
                const nCx = current.cx + dir.dx;
                const nCy = current.cy + dir.dy;
                if ((currentCell.nswe & dir.bit) === 0) {
                    continue;
                }

                const nCell = this.getCellData((nCx << 4) + 8, (nCy << 4) + 8, currentCell.z);
                const key = `${nCx},${nCy},${nCell.z}`;

                if ((nCell.nswe & dir.oppBit) === 0) {
                    continue;
                }

                if (Math.abs(nCell.z - currentCell.z) > MAX_LAYER_STEP) {
                    continue;
                }

                const g = current.g + 16;
                const previousCost = bestCosts.get(key);
                if (previousCost !== undefined && previousCost <= g) {
                    continue;
                }

                const h = heuristic(nCx, nCy, nCell.z);
                const f = g + heuristicWeight * h;

                const neighbor = {
                    cx: nCx,
                    cy: nCy,
                    cz: nCell.z,
                    g: g,
                    h: h,
                    f: f,
                    parent: current,
                    order: insertOrder++
                };

                bestCosts.set(key, g);
                openList.push(neighbor);
            }
        }
        
        if ((invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) && options.debug !== false) {
            console.log(`findPath :: nodesExpanded = ${nodesExpanded}, targetNodeFound = ${!!targetNode}`);
        }

        let node = targetNode;
        if (!node) {
            return null;
        }

        const pathPoints = [];
        while (node) {
            pathPoints.push({
                locX: (node.cx << 4) + 8,
                locY: (node.cy << 4) + 8,
                locZ: node.cz
            });
            node = node.parent;
        }
        pathPoints.reverse();

        const smoothedPath = [];
        if (pathPoints.length > 0) {
            smoothedPath.push(pathPoints[0]);
            let currentIdx = 0;

            while (currentIdx < pathPoints.length - 1) {
                checkBudget?.();
                let checkIdx = pathPoints.length - 1;
                while (checkIdx > currentIdx + 1) {
                    if ((checkIdx & 31) === 0) checkBudget?.();
                    const startPt = pathPoints[currentIdx];
                    const endPt = pathPoints[checkIdx];
                    if (this.walkSegment(startPt, endPt)) {
                        break;
                    }
                    checkIdx--;
                }
                smoothedPath.push(pathPoints[checkIdx]);
                currentIdx = checkIdx;
            }
        }

        if (smoothedPath.length > 0 && goalRadius <= 0) {
            smoothedPath[smoothedPath.length - 1] = {
                locX: endX,
                locY: endY,
                locZ: endZ
            };
        }

        return smoothedPath;
    },

    buildOffsetIndex(buffer) {
        const index = new Int32Array(256 * 256);
        let offset = 0;
        let blockCount = 0;
        const totalBlocks = 256 * 256;

        while (offset < buffer.length && blockCount < totalBlocks) {
            index[blockCount] = offset;
            const type = buffer.readUInt8(offset);
            offset += 1;

            if (type === 0) {
                offset += 2;
            } else if (type === 1) {
                offset += 128;
            } else if (type === 2) {
                for (let i = 0; i < 64; i++) {
                    const layers = buffer.readUInt8(offset);
                    offset += 1 + (layers * 2);
                }
            }
            blockCount++;
        }
        return index;
    }
};

module.exports = GeodataEngine;
