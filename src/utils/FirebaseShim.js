const admin = require('../config/firebase');

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
      if (!result) return resolve ? resolve(result) : result;

      const isArray = Array.isArray(result);
      const list = isArray ? result : [result];

      for (const doc of list) {
        if (doc && typeof doc === 'object' && doc._id) {
          doc.save = async () => {
            const toSave = { ...doc };
            delete toSave.save;
            delete toSave.select;
            delete toSave.populate;
            return await this.model.findByIdAndUpdate(doc._id, toSave);
          };
          doc.select = function() { return this; };
        }
      }

      for (const path of this.populatePaths) {
        const pathLower = path.toLowerCase();
        let collection = 'users'; 
        if (pathLower.includes('stock')) collection = 'stocks';
        if (pathLower.includes('transaction')) collection = 'transactions';
        if (pathLower.includes('listing')) collection = 'listings';
        
        const TargetModel = new FirebaseShim(collection);
        for (const doc of list) {
          if (doc[path] && typeof doc[path] === 'string') {
            doc[path] = await TargetModel.findById(doc[path]);
          }
        }
      }

      const finalResult = isArray ? list : list[0];
      if (resolve) resolve(finalResult);
      return finalResult;
    } catch (err) {
      if (reject) reject(err);
      throw err;
    }
  }
}

class FirebaseShim {
  constructor(collection) {
    this.collection = collection;
  }

  get db() {
    try {
      return admin.database();
    } catch (err) {
      console.error('[NEURAL SHIM ERROR] Database access failed. Ensure Firebase is initialized.', err.message);
      throw err;
    }
  }

  get ref() {
    return this.db.ref(this.collection);
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
    payload.save = async () => {
      const toSave = { ...payload };
      delete toSave.save;
      return await this.findByIdAndUpdate(payload._id, toSave);
    };
    return payload;
  }

  async findByIdAndUpdate(id, update, options = {}) {
    if (!id) return null;
    const currentSnap = await this.ref.child(id).once('value');
    const current = currentSnap.val() ? { ...currentSnap.val(), _id: id } : null;
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

    const cleanUpdate = {};
    Object.keys(payload).forEach(k => { if (typeof payload[k] !== 'function') cleanUpdate[k] = payload[k]; });

    const finalData = { ...current, ...cleanUpdate, updatedAt: new Date().toISOString() };
    await this.ref.child(id).set(finalData);
    return finalData;
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const doc = await this.findOne(filter);
    if (!doc) return null;
    return this.findByIdAndUpdate(doc._id, update, options);
  }

  async countDocuments(filter = {}) {
    const docs = await this.find(filter);
    return docs.length;
  }

  async findByIdAndDelete(id) {
    await this.ref.child(id).remove();
    return true;
  }

  async insertMany(dataArray) {
    if (!Array.isArray(dataArray)) return [];
    const promises = dataArray.map(data => this.create(data));
    return Promise.all(promises);
  }

  async deleteMany(filter = {}) {
    const docs = await this.find(filter);
    const promises = docs.map(doc => this.findByIdAndDelete(doc._id));
    await Promise.all(promises);
    return { deletedCount: docs.length };
  }
}

module.exports = FirebaseShim;
