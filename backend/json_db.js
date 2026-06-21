const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '../data/json_db');

function ensureDb() {
    if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
    }
}

function load(name) {
    ensureDb();
    const file = path.join(DB_DIR, `${name}.json`);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
}

function save(name, data) {
    ensureDb();
    const file = path.join(DB_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function generateId() {
    return new mongoose.Types.ObjectId().toString();
}

const mongoose = require('mongoose');

class JsonCollection {
    constructor(name) {
        this.name = name;
        this._data = load(name);
    }

    _persist() {
        save(this.name, this._data);
    }

    find(query = {}) {
        let results = [...this._data];
        for (const [key, val] of Object.entries(query)) {
            if (key === '$or' && Array.isArray(val)) {
                results = results.filter(item =>
                    val.some(cond => {
                        for (const [k, v] of Object.entries(cond)) {
                            if (k === 'topFeatures.name') {
                                const regex = new RegExp(v.$options === 'i' ? v.$regex : v, 'i');
                                if (!item.topFeatures?.some(f => regex.test(f.name))) return false;
                            } else {
                                const regex = typeof v === 'object' && v.$regex ? new RegExp(v.$regex, v.$options || '') : new RegExp(v, 'i');
                                if (!regex.test(String(item[k] ?? ''))) return false;
                            }
                        }
                        return true;
                    })
                );
            } else if (key === 'sourceFileName') {
                results = results.filter(item => item.sourceFileName === val);
            } else if (key === 'status') {
                results = results.filter(item => item.status === val);
            } else {
                results = results.filter(item => item[key] === val);
            }
        }
        return results;
    }

    findById(id) {
        return this._data.find(item => item._id === id) || null;
    }

    findByIdAndUpdate(id, update, opts = {}) {
        const idx = this._data.findIndex(item => item._id === id);
        if (idx === -1) return null;
        if (update.$set) {
            Object.assign(this._data[idx], update.$set);
        }
        if (opts.new !== false) {
            this._persist();
            return this._data[idx];
        }
        this._persist();
        return null;
    }

    countDocuments(query = {}) {
        return this.find(query).length;
    }

    distinct(field) {
        return [...new Set(this._data.map(item => item[field]).filter(Boolean))];
    }

    sort(sortObj) {
        const key = Object.keys(sortObj)[0];
        const dir = sortObj[key];
        this._data.sort((a, b) => {
            const va = a[key] ?? 0;
            const vb = b[key] ?? 0;
            return dir === -1 ? vb - va : va - vb;
        });
        return this;
    }

    skip(n) {
        this._skip = n;
        return this;
    }

    limit(n) {
        this._limit = n;
        return this;
    }

    lean() {
        let results = [...this._data];
        if (this._skip) { results = results.slice(this._skip); this._skip = 0; }
        if (this._limit) { results = results.slice(0, this._limit); this._limit = 0; }
        return results;
    }

    create(doc) {
        const newDoc = { _id: new mongoose.Types.ObjectId().toString(), ...doc };
        this._data.push(newDoc);
        this._persist();
        return newDoc;
    }

    insertMany(docs) {
        const newDocs = docs.map(d => ({ _id: new mongoose.Types.ObjectId().toString(), ...d }));
        this._data.push(...newDocs);
        this._persist();
        return newDocs;
    }

    bulkWrite(ops) {
        for (const op of ops) {
            if (op.updateOne) {
                const { filter, update, upsert } = op.updateOne;
                const idx = this._data.findIndex(item => {
                    return Object.entries(filter).every(([k, v]) => item[k] === v);
                });
                if (idx >= 0) {
                    if (update.$set) Object.assign(this._data[idx], update.$set);
                } else if (upsert) {
                    const newDoc = { _id: new mongoose.Types.ObjectId().toString(), ...filter };
                    if (update.$set) Object.assign(newDoc, update.$set);
                    this._data.push(newDoc);
                }
            }
        }
        this._persist();
    }

    deleteMany(query = {}) {
        const before = this._data.length;
        if (Object.keys(query).length === 0) {
            this._data = [];
        } else {
            this._data = this._data.filter(item => {
                return !Object.entries(query).every(([k, v]) => item[k] === v);
            });
        }
        this._persist();
    }

    findOneAndUpdate(filter, update, opts = {}) {
        const idx = this._data.findIndex(item => {
            return Object.entries(filter).every(([k, v]) => item[k] === v);
        });
        if (idx === -1) {
            if (opts.upsert) {
                const newDoc = { _id: new mongoose.Types.ObjectId().toString(), ...filter };
                if (update.$set) Object.assign(newDoc, update.$set);
                if (update.$inc) {
                    for (const [k, v] of Object.entries(update.$inc)) {
                        newDoc[k] = (newDoc[k] || 0) + v;
                    }
                }
                if (update.$setOnInsert) Object.assign(newDoc, update.$setOnInsert);
                this._data.push(newDoc);
                this._persist();
                return opts.returnDocument === 'after' ? newDoc : null;
            }
            return null;
        }
        if (update.$set) Object.assign(this._data[idx], update.$set);
        if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
                this._data[idx][k] = (this._data[idx][k] || 0) + v;
            }
        }
        this._persist();
        return opts.returnDocument === 'after' ? this._data[idx] : null;
    }
}

const collections = {};

module.exports = {
    getCollection(name) {
        if (!collections[name]) {
            collections[name] = new JsonCollection(name);
        }
        return collections[name];
    },
    clear() {
        for (const name of Object.keys(collections)) {
            collections[name]._data = [];
            collections[name]._persist();
        }
    }
};
