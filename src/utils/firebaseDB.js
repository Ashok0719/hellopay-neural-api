const admin = require('../config/firebase');
const db = admin.database();

class FirebaseDB {
  static async get(path) {
    const snapshot = await db.ref(path).once('value');
    return snapshot.val();
  }

  static async set(path, data) {
    await db.ref(path).set({
      ...data,
      updatedAt: new Date().toISOString()
    });
    return data;
  }

  static async update(path, data) {
    await db.ref(path).update({
      ...data,
      updatedAt: new Date().toISOString()
    });
    return data;
  }

  static async push(path, data) {
    const newRef = db.ref(path).push();
    const payload = {
      ...data,
      _id: newRef.key,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await newRef.set(payload);
    return payload;
  }

  static async delete(path) {
    await db.ref(path).remove();
    return true;
  }

  // Mimic Mongoose findOne
  static async findOne(collection, queryField, queryValue) {
    const snapshot = await db.ref(collection)
      .orderByChild(queryField)
      .equalTo(queryValue)
      .limitToFirst(1)
      .once('value');
    
    const data = snapshot.val();
    if (!data) return null;
    
    const key = Object.keys(data)[0];
    return { ...data[key], _id: key };
  }

  // Mimic Mongoose find
  static async find(collection, queryField, queryValue) {
    let ref = db.ref(collection);
    if (queryField && queryValue !== undefined) {
      ref = ref.orderByChild(queryField).equalTo(queryValue);
    }
    const snapshot = await ref.once('value');
    const data = snapshot.val();
    if (!data) return [];
    
    return Object.keys(data).map(key => ({ ...data[key], _id: key }));
  }
}

module.exports = FirebaseDB;
