const admin = require('../config/firebase');
const db = admin.database();

class FirebaseQuery {
  constructor(model, promise) {
    this.model = model;
    this.promise = promise;
    this.populatePaths = [];
  }

  populate(path, modelNameOrFields) {
    this.populatePaths.push(path);
    return this;
  }

  sort(options) { return this; }
  limit(n) { return this; }
  select(fields) { return this; }

  async then(resolve, reject) {
    try {
      let result = await this.promise;
      if (!result) return resolve(result);

      // Handle population
      for (const path of this.populatePaths) {
        // Robust mapping for HelloPay common entities
        const pathLower = path.toLowerCase();
        let collection = 'users'; // default
        if (pathLower.includes('stock')) collection = 'stocks';
        if (pathLower.includes('transaction')) collection = 'transactions';
        if (pathLower.includes('listing')) collection = 'listings';
        
        const TargetModel = new FirebaseShim(collection);
        
        const isArray = Array.isArray(result);
        const list = isArray ? result : [result];
        for (const doc of list) {
          if (doc[path] && typeof doc[path] === 'string') {
            doc[path] = await TargetModel.findById(doc[path]);
          }
        }
      }
      if (resolve) resolve(result);
      return result;
    } catch (err) {
      if (reject) reject(err);
      throw err;
    }
  }
}

class FirebaseShim {
  constructor(collection) {
    this.collection = collection;
    this.ref = db.ref(collection);
  }

  findOne(filter = {}) {
    let queryRef = this.ref;
    const keys = Object.keys(filter);
    if (keys.length > 0) {
      queryRef = queryRef.orderByChild(keys[0]).equalTo(filter[keys[0]]).limitToFirst(1);
    }
    const promise = queryRef.once('value').then(snap => {
      const val = snap.val();
      if (!val) return null;
      const key = Object.keys(val)[0];
      return { ...val[key], _id: key, id: key };
    });
    return new FirebaseQuery(this, promise);
  }

  findById(id) {
    if (!id) return new FirebaseQuery(this, Promise.resolve(null));
    const promise = this.ref.child(id).once('value').then(snap => {
      const val = snap.val();
      if (!val) return null;
      return { ...val, _id: id, id: id };
    });
    return new FirebaseQuery(this, promise);
  }

  find(filter = {}) {
    let queryRef = this.ref;
    const keys = Object.keys(filter);
    if (keys.length > 0) {
      // RTDB only supports one orderBy per query.
      queryRef = queryRef.orderByChild(keys[0]).equalTo(filter[keys[0]]);
    }
    const promise = queryRef.once('value').then(snap => {
      const val = snap.val();
      if (!val) return [];
      return Object.keys(val).map(key => ({ ...val[key], _id: key, id: key }));
    });
    return new FirebaseQuery(this, promise);
  }

  async create(data) {
    const newRef = this.ref.push();
    const payload = {
      ...data,
      _id: newRef.key,
      id: newRef.key,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await newRef.set(payload);
    return payload;
  }

  async findByIdAndUpdate(id, update, options = {}) {
    if (!id) return null;
    const current = await this.findById(id);
    if (!current) return null;

    let payload = { ...update };
    if (update.$inc) {
      Object.keys(update.$inc).forEach(key => { payload[key] = (current[key] || 0) + update.$inc[key]; });
      delete payload.$inc;
    }
    if (update.$push) {
      Object.keys(update.$push).forEach(key => { const arr = current[key] || []; arr.push(update.$push[key]); payload[key] = arr; });
      delete payload.$push;
    }

    const finalData = { ...current, ...payload, updatedAt: new Date().toISOString() };
    await this.ref.child(id).set(finalData);
    return finalData;
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const doc = await this.findOne(filter);
    if (!doc) return null;
    return this.findByIdAndUpdate(doc._id, update, options);
  }

  async countDocuments(filter = {}) {
    // Standardize to avoid count issues
    const docs = await this.find(filter);
    return docs.length;
  }

  async findByIdAndDelete(id) {
    await this.ref.child(id).remove();
    return true;
  }
}

module.exports = FirebaseShim;
