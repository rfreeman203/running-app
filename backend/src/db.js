const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [] }; }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const db = {
  users: {
    findBy(key, value) {
      return load().users.find(u => u[key] === value) ?? null;
    },
    insert(user) {
      const data = load();
      data.users.push({ ...user, created_at: Date.now() });
      save(data);
    },
    update(id, fields) {
      const data = load();
      const i = data.users.findIndex(u => u.id === id);
      if (i !== -1) { data.users[i] = { ...data.users[i], ...fields }; save(data); }
    },
    remove(id) {
      const data = load();
      data.users = data.users.filter(u => u.id !== id);
      save(data);
    },
  },
};

module.exports = db;
