// Explicit offline profiling only: no Database.init(), World.init(), listeners,
// NPC publication or workers. Cache/profile outputs stay outside authored data.
const fs = require('node:fs');
const path = require('node:path');
const { Session } = require('node:inspector/promises');

async function main() {
    const args = process.argv.slice(2);
    const settings = { cold: false, seed: 1 };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--cold') settings.cold = true;
        else if (['--output', '--cache', '--seed'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) settings[args[i].slice(2)] = args[++i];
        else throw new Error('Usage: node scripts/profile-spawn-placement.js --output tmp/profiles/<new-run> [--cold] [--cache <file>] [--seed <uint32>]');
    }
    const seed = Number(settings.seed);
    if (!settings.output || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('An output directory and uint32 seed are required');
    const output = path.resolve(settings.output);
    const artifactRoot = path.resolve(__dirname, '../tmp');
    if (!output.startsWith(artifactRoot + path.sep)) throw new Error('Profile output must be below repository tmp/');
    if (fs.existsSync(output)) throw new Error('Use a new output directory for each profiling run');
    fs.mkdirSync(output, { recursive: true });
    const cachePath = settings.cache ? path.resolve(settings.cache) : path.join(output, 'spawn-placement.json');
    if (!cachePath.startsWith(artifactRoot + path.sep)) throw new Error('Cache must be below repository tmp/');

    // The same seed makes cold comparisons use the same sampled cells. This is
    // local to this process; the game keeps its normal random source.
    let state = seed;
    Math.random = () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    require('../src/Global');
    invoke('GameServer/DataCache').init();
    invoke('GameServer/Geodata/GeodataEngine').init();
    const placement = invoke('GameServer/Geodata/SpawnPlacement');
    const session = new Session();
    session.connect();
    try {
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: 10000 });
        await session.post('Profiler.start');
        const cpu = process.cpuUsage();
        const result = placement.init(invoke('GameServer/DataCache').npcSpawns, { cachePath, rebuild: settings.cold });
        const cpuUsage = process.cpuUsage(cpu);
        const { profile } = await session.post('Profiler.stop');
        fs.writeFileSync(path.join(output, 'spawn-placement.cpuprofile'), JSON.stringify(profile));
        const samples = new Map();
        for (let i = 0; i < profile.samples.length; i++) {
            const id = profile.samples[i];
            samples.set(id, (samples.get(id) || 0) + profile.timeDeltas[i]);
        }
        const total = [...samples.values()].reduce((sum, value) => sum + value, 0);
        const frames = new Map();
        for (const node of profile.nodes) {
            const frame = node.callFrame;
            const key = JSON.stringify([frame.functionName, frame.url, frame.lineNumber]);
            if (!frames.has(key)) frames.set(key, { function: frame.functionName || '(anonymous)',
                file: frame.url, line: frame.lineNumber + 1, selfMs: 0 });
            frames.get(key).selfMs += (samples.get(node.id) || 0) / 1000;
        }
        const top = [...frames.values()].map(frame => ({ ...frame,
            percent: Math.round(frame.selfMs / total * 10000000) / 100
        })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 30);
        const summary = { ...result, seed, cold: settings.cold, cachePath, node: process.version,
            cpuUsage, memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, top };
        fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
        console.info('Spawn profile:', JSON.stringify(summary));
    } finally {
        session.disconnect();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
