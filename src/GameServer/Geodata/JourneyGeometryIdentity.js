(function bootstrap(module, require) {
    'use strict';
    const { createHash } = require('node:crypto');
    const path = require('node:path');
    const entries = new Map();
    const hash = value => createHash('sha256').update(value).digest('hex');
    const sourceOf = Function.prototype.toString;

    // Attest the complete compiled factory, not exported functions: private
    // decoders and closed constants are part of the executed source too. The
    // fixed envelope makes current disk bytes independently comparable later.
    function define(owner, localRequire, factory) {
        const relative = path.relative(path.dirname(owner.filename), __filename).split(path.sep).join('/');
        const request = relative.startsWith('.') ? relative : `./${relative}`;
        const source = `require('${request}').define(module, require, ${sourceOf.call(factory)});\n`;
        const jsonInputs = new Map();
        function trackedRequire(name) {
            const value = localRequire(name);
            if (name.endsWith('.json')) jsonInputs.set(localRequire.resolve(name), hash(JSON.stringify(value)));
            return value;
        }
        Object.assign(trackedRequire, localRequire);
        const dependencies = factory(owner, owner.exports, trackedRequire, owner.filename, path.dirname(owner.filename)) || [];
        const functions = Object.entries(owner.exports).filter(([, value]) => typeof value === 'function');
        entries.set(owner.filename, { owner, exports: owner.exports, sha256: hash(source), jsonInputs, dependencies, functions });
    }

    function verify(file, diskSha256, jsonDigests) {
        const entry = entries.get(file);
        if (!entry || entry.owner !== require.cache[file] || entry.exports !== entry.owner.exports) {
            throw new Error(`journey_algorithm_provenance_missing:${file}`);
        }
        if (entry.sha256 !== diskSha256) throw new Error(`journey_loaded_algorithm_mismatch:${file}`);
        for (const [name, value] of entry.functions) if (entry.exports[name] !== value) {
            throw new Error(`journey_loaded_algorithm_export_mismatch:${file}:${name}`);
        }
        for (const [jsonFile, loadedDigest] of entry.jsonInputs) {
            if (jsonDigests.get(jsonFile) !== loadedDigest) throw new Error(`journey_loaded_admission_input_mismatch:${jsonFile}`);
        }
        for (const [dependencyFile, value] of entry.dependencies) {
            if (require.cache[dependencyFile]?.exports !== value) {
                throw new Error(`journey_loaded_algorithm_dependency_mismatch:${dependencyFile}`);
            }
        }
    }

    function jsonFiles() {
        return [...new Set([...entries.values()].flatMap(entry => [...entry.jsonInputs.keys()]))];
    }

    module.exports = Object.freeze({ define, verify, jsonFiles });
    entries.set(__filename, { owner: module, exports: module.exports,
        sha256: hash(`(${sourceOf.call(bootstrap)})(module, require);\n`), jsonInputs: new Map(), dependencies: [],
        functions: Object.entries(module.exports) });
})(module, require);
