const crypto = require('crypto');

function generateId() {
    return crypto.randomBytes(12).toString('hex');
}

class MockCollection {
    constructor(name) {
        this._data = [];
    }

    find(query = {}) { return new MockQuery(this._data, query); }

    findById(id) {
        const item = this._data.find(d => d._id === id);
        return Promise.resolve(item ? JSON.parse(JSON.stringify(item)) : null);
    }

    findByIdAndUpdate(id, update, opts = {}) {
        const idx = this._data.findIndex(d => d._id === id);
        if (idx === -1) return Promise.resolve(null);
        if (update.$set) Object.assign(this._data[idx], update.$set);
        const result = opts.new !== false ? this._data[idx] : null;
        return Promise.resolve(result ? JSON.parse(JSON.stringify(result)) : null);
    }

    countDocuments(query = {}) {
        const q = new MockQuery(this._data, query);
        return Promise.resolve(q._exec().length);
    }

    distinct(field) {
        return Promise.resolve([...new Set(this._data.map(d => d[field]).filter(Boolean))]);
    }

    create(doc) {
        const newDoc = { _id: generateId(), ...doc, __v: 0 };
        this._data.push(newDoc);
        return Promise.resolve(JSON.parse(JSON.stringify(newDoc)));
    }

    insertMany(docs) {
        const newDocs = docs.map(d => ({ _id: generateId(), ...d, __v: 0 }));
        this._data.push(...newDocs);
        return Promise.resolve(newDocs.map(d => JSON.parse(JSON.stringify(d))));
    }

    bulkWrite(ops) {
        for (const op of ops) {
            if (op.updateOne) {
                const { filter, update, upsert } = op.updateOne;
                const idx = this._data.findIndex(d => Object.entries(filter).every(([k, v]) => d[k] === v));
                if (idx >= 0) {
                    if (update.$set) Object.assign(this._data[idx], update.$set);
                } else if (upsert) {
                    const newDoc = { _id: generateId(), ...filter, __v: 0 };
                    if (update.$set) Object.assign(newDoc, update.$set);
                    this._data.push(newDoc);
                }
            }
        }
        return Promise.resolve();
    }

    deleteMany(query = {}) {
        if (Object.keys(query).length === 0) {
            this._data = [];
        } else {
            this._data = this._data.filter(d => !Object.entries(query).every(([k, v]) => d[k] === v));
        }
        return Promise.resolve();
    }

    findOneAndUpdate(filter, update, opts = {}) {
        const idx = this._data.findIndex(d => Object.entries(filter).every(([k, v]) => d[k] === v));
        if (idx === -1) {
            if (opts.upsert) {
                const newDoc = { _id: generateId(), ...filter, __v: 0 };
                if (update.$set) Object.assign(newDoc, update.$set);
                if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) newDoc[k] = (newDoc[k] || 0) + v; }
                if (update.$setOnInsert) Object.assign(newDoc, update.$setOnInsert);
                this._data.push(newDoc);
                return Promise.resolve(opts.returnDocument === 'after' ? JSON.parse(JSON.stringify(newDoc)) : null);
            }
            return Promise.resolve(null);
        }
        if (update.$set) Object.assign(this._data[idx], update.$set);
        if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) this._data[idx][k] = (this._data[idx][k] || 0) + v; }
        this._data[idx] = { ...this._data[idx] };
        return Promise.resolve(opts.returnDocument === 'after' ? JSON.parse(JSON.stringify(this._data[idx])) : null);
    }

    findOne(query = {}) {
        const results = this._matchAll(query);
        return Promise.resolve(results.length > 0 ? JSON.parse(JSON.stringify(results[0])) : null);
    }

    _matchAll(query) {
        return this._data.filter(d => {
            for (const [k, v] of Object.entries(query)) {
                if (k === '$or' && Array.isArray(v)) {
                    const match = v.some(cond => {
                        for (const [ck, cv] of Object.entries(cond)) {
                            if (ck === 'topFeatures.name') {
                                const regex = new RegExp(cv.$options === 'i' ? cv.$regex : cv, 'i');
                                if (!d.topFeatures?.some(f => regex.test(f.name))) return false;
                            } else {
                                const regex = typeof cv === 'object' && cv.$regex ? new RegExp(cv.$regex, cv.$options || '') : new RegExp(cv, 'i');
                                if (!regex.test(String(d[ck] ?? ''))) return false;
                            }
                        }
                        return true;
                    });
                    if (!match) return false;
                } else if (typeof v === 'object' && v !== null && v.$regex) {
                    const regex = new RegExp(v.$regex, v.$options || '');
                    if (!regex.test(String(d[k] ?? ''))) return false;
                } else if (d[k] !== v) {
                    return false;
                }
            }
            return true;
        });
    }
}

class MockQuery {
    constructor(data, query) {
        this._data = data;
        this._query = query;
        this._sortObj = null;
        this._skipVal = 0;
        this._limitVal = 0;
    }

    _matchAll() {
        let results = [...this._data];
        for (const [k, v] of Object.entries(this._query)) {
            if (k === '$or' && Array.isArray(v)) {
                results = results.filter(d =>
                    v.some(cond => Object.entries(cond).every(([ck, cv]) => {
                        if (ck === 'topFeatures.name') {
                            const regex = new RegExp(cv.$options === 'i' ? cv.$regex : cv, 'i');
                            return d.topFeatures?.some(f => regex.test(f.name));
                        }
                        const regex = typeof cv === 'object' && cv.$regex ? new RegExp(cv.$regex, cv.$options || '') : new RegExp(cv, 'i');
                        return regex.test(String(d[ck] ?? ''));
                    }))
                );
            } else if (k === 'sourceFileName') {
                results = results.filter(d => d.sourceFileName === v);
            } else if (k === 'status') {
                results = results.filter(d => d.status === v);
            } else if (typeof v === 'object' && v !== null && v.$regex !== undefined) {
                const regex = new RegExp(v.$regex, v.$options || '');
                results = results.filter(d => regex.test(String(d[k] ?? '')));
            } else {
                results = results.filter(d => d[k] === v);
            }
        }
        return results;
    }

    sort(sortObj) {
        this._sortObj = sortObj;
        return this;
    }

    skip(n) {
        this._skipVal = n;
        return this;
    }

    limit(n) {
        this._limitVal = n;
        return this;
    }

    lean() {
        let results = this._matchAll();
        if (this._sortObj) {
            const key = Object.keys(this._sortObj)[0];
            const dir = this._sortObj[key];
            results.sort((a, b) => dir === -1 ? (b[key] || 0) - (a[key] || 0) : (a[key] || 0) - (b[key] || 0));
        }
        if (this._skipVal) { results = results.slice(this._skipVal); }
        if (this._limitVal) { results = results.slice(0, this._limitVal); }
        return Promise.resolve(results.map(d => JSON.parse(JSON.stringify(d))));
    }

    then(resolve) {
        return this.lean().then(resolve);
    }
}

const collections = {};
function getModel(name) {
    if (!collections[name]) {
        collections[name] = new MockCollection(name);
    }
    return collections[name];
}

module.exports = { getModel, generateId };
