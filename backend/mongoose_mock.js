const crypto = require('crypto');

// Mini MongoDB-compatible in-memory store
class Document {
    constructor(schema, data) {
        Object.assign(this, data);
        if (!this._id) this._id = crypto.randomBytes(12).toString('hex');
    }
    save() { return Promise.resolve(this); }
    toJSON() { return { ...this }; }
    toObject() { return { ...this }; }
}

class Model {
    constructor(name, schema) {
        this.name = name;
        this.schema = schema;
        this._data = [];
    }
    find(query = {}) { return new Query(this._data, query); }
    findById(id) { return this.findOne({ _id: id }); }
    findByIdAndUpdate(id, update, opts = {}) {
        const item = this._data.find(d => d._id === id);
        if (!item) return Promise.resolve(null);
        if (update.$set) Object.assign(item, update.$set);
        if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) item[k] = (item[k] || 0) + v; }
        return Promise.resolve(opts.new !== false ? JSON.parse(JSON.stringify(item)) : null);
    }
    countDocuments(query = {}) { return this.find(query).then(r => r.length); }
    distinct(field) { return Promise.resolve([...new Set(this._data.map(d => d[field]).filter(Boolean))]); }
    create(data) { const d = new Document(this.schema, data); this._data.push(d); return Promise.resolve(d); }
    insertMany(docs) {
        const items = docs.map(d => { const x = new Document(this.schema, d); this._data.push(x); return x; });
        return Promise.resolve(items);
    }
    bulkWrite(ops) {
        for (const op of ops) {
            if (op.updateOne) {
                const { filter, update, upsert } = op.updateOne;
                const idx = this._data.findIndex(d => Object.entries(filter).every(([k, v]) => d[k] === v));
                if (idx >= 0) { if (update.$set) Object.assign(this._data[idx], update.$set); }
                else if (upsert) {
                    const d = new Document(this.schema, { ...filter });
                    if (update.$set) Object.assign(d, update.$set);
                    this._data.push(d);
                }
            }
        }
        return Promise.resolve();
    }
    deleteMany(query = {}) {
        if (Object.keys(query).length === 0) { this._data = []; }
        else { this._data = this._data.filter(d => !Object.entries(query).every(([k, v]) => d[k] === v)); }
        return Promise.resolve();
    }
    findOneAndUpdate(filter, update, opts = {}) {
        const idx = this._data.findIndex(d => Object.entries(filter).every(([k, v]) => d[k] === v));
        if (idx === -1) {
            if (opts.upsert) {
                const d = new Document(this.schema, { ...filter });
                if (update.$set) Object.assign(d, update.$set);
                if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) d[k] = (d[k] || 0) + v; }
                if (update.$setOnInsert) Object.assign(d, update.$setOnInsert);
                this._data.push(d);
                return Promise.resolve(opts.returnDocument === 'after' ? JSON.parse(JSON.stringify(d)) : null);
            }
            return Promise.resolve(null);
        }
        if (update.$set) Object.assign(this._data[idx], update.$set);
        if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) this._data[idx][k] = (this._data[idx][k] || 0) + v; }
        return Promise.resolve(opts.returnDocument === 'after' ? JSON.parse(JSON.stringify(this._data[idx])) : null);
    }
    updateOne(filter, update, opts = {}) {
        return this.findOneAndUpdate(filter, update, { ...opts, returnDocument: 'after' }).then(() => ({ acknowledged: true, modifiedCount: 1 }));
    }
    findOne(query = {}) { const q = new Query(this._data, query); q._single = true; return q; }
}

class Query {
    constructor(data, query) { this._data = data; this._query = query; this._sortObj = null; this._skipVal = 0; this._limitVal = 0; }
    _matchAll() {
        let r = [...this._data];
        for (const [k, v] of Object.entries(this._query)) {
            if (k === '$or' && Array.isArray(v)) {
                r = r.filter(d => v.some(cond => Object.entries(cond).every(([ck, cv]) => {
                    const regex = typeof cv === 'object' && cv.$regex ? new RegExp(cv.$regex, cv.$options || '') : new RegExp(cv, 'i');
                    if (ck === 'topFeatures.name') return d.topFeatures?.some(f => regex.test(f.name));
                    return regex.test(String(d[ck] ?? ''));
                })));
            } else if (typeof v === 'object' && v !== null && v.$regex !== undefined) {
                const regex = new RegExp(v.$regex, v.$options || '');
                r = r.filter(d => regex.test(String(d[k] ?? '')));
            } else { r = r.filter(d => d[k] === v); }
        }
        return r;
    }
    sort(o) { this._sortObj = o; return this; }
    skip(n) { this._skipVal = n; return this; }
    limit(n) { this._limitVal = n; return this; }
    lean() {
        let r = this._matchAll();
        if (this._sortObj) { const k = Object.keys(this._sortObj)[0]; const d = this._sortObj[k]; r.sort((a, b) => d === -1 ? (b[k] || 0) - (a[k] || 0) : (a[k] || 0) - (b[k] || 0)); }
        if (this._skipVal) r = r.slice(this._skipVal);
        if (this._limitVal) r = r.slice(0, this._limitVal);
        const mapped = r.map(x => JSON.parse(JSON.stringify(x)));
        return Promise.resolve(this._single ? (mapped.length > 0 ? mapped[0] : null) : mapped);
    }
    then(resolve, reject) { return this.lean().then(resolve, reject); }
}

const dbState = { readyState: 1 };
const models = {};
const mockMongoose = {
    connect(uri) {
        dbState.readyState = 1;
        console.log('[mock db] Connected to', uri);
        return Promise.resolve();
    },
    disconnect() {
        dbState.readyState = 0;
        return Promise.resolve();
    },
    model(name, schema) {
        if (schema === undefined) return models[name];
        if (!models[name]) {
            const modelInst = new Model(name, schema);
            const proxyFn = function(data) {
                const doc = new Document(schema, data);
                doc.save = function() {
                    modelInst._data.push(this);
                    return Promise.resolve(this);
                };
                return doc;
            };
            models[name] = new Proxy(proxyFn, {
                get(target, prop) {
                    if (typeof modelInst[prop] === 'function') {
                        return modelInst[prop].bind(modelInst);
                    }
                    return modelInst[prop];
                },
                set(target, prop, value) {
                    modelInst[prop] = value;
                    return true;
                }
            });
        }
        return models[name];
    },
    Types: { ObjectId: { toString: () => crypto.randomBytes(12).toString('hex') }, Mixed: Object },
    Schema: function(def, opts) { return { definition: def, options: opts }; },
    connection: {
        on: (evt, fn) => { if (evt === 'connected') setTimeout(fn, 0); },
        readyState: 1,
        close: () => Promise.resolve(),
    },
    set: () => {},
};
mockMongoose.Schema.Types = { Mixed: Object, ObjectId: { toString: () => crypto.randomBytes(12).toString('hex') } };

module.exports = mockMongoose;
